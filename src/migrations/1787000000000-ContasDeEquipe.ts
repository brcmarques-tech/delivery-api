import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KAN-82 — contas de equipe do lojista.
 *
 * Hoje a loja tem UMA conta, então o dono passa a senha para o atendente que
 * despacha pedidos — e junto vão os recebimentos, os dados bancários e o poder
 * de apagar produtos. Esta tabela é o que permite o atendente ter a própria
 * conta, com acesso só ao que o dono liberou.
 *
 * Toda instrução é idempotente (KAN-283): rodar duas vezes não pode abortar o
 * boot.
 */
export class ContasDeEquipe1787000000000 implements MigrationInterface {
  name = 'ContasDeEquipe1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vendor_team_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ownerId" uuid NOT NULL,
        "storeId" uuid NOT NULL,
        "memberEmail" character varying NOT NULL,
        "memberId" uuid,
        "role" character varying NOT NULL DEFAULT 'EMPLOYEE',
        "permissions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "inviteTokenHash" character varying,
        "invitedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "acceptedAt" TIMESTAMP,
        "revokedAt" TIMESTAMP,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vendor_team_members" PRIMARY KEY ("id")
      )
    `);

    // O membro é consultado a cada operação na loja (o guard de permissão), e
    // o convite é procurado pelo hash do token. Sem estes índices, cada ação
    // do funcionário vira scan.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_equipe_store" ON "vendor_team_members" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_equipe_member" ON "vendor_team_members" ("memberId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_equipe_owner" ON "vendor_team_members" ("ownerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_equipe_token" ON "vendor_team_members" ("inviteTokenHash")`,
    );

    // Unicidade PARCIAL: um e-mail não pode ter dois convites VIVOS na mesma
    // loja — mas pode ser reconvidado depois de revogado. Um UNIQUE comum
    // (storeId, memberEmail) impediria o reconvite para sempre, que é um caso
    // comum: funcionário sai, volta.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_equipe_loja_email_vivo"
        ON "vendor_team_members" ("storeId", lower("memberEmail"))
        WHERE "revokedAt" IS NULL
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "vendor_team_members"
          ADD CONSTRAINT "FK_equipe_owner" FOREIGN KEY ("ownerId")
          REFERENCES "vendor_users"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "vendor_team_members"
          ADD CONSTRAINT "FK_equipe_store" FOREIGN KEY ("storeId")
          REFERENCES "stores"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "vendor_team_members"
          ADD CONSTRAINT "FK_equipe_member" FOREIGN KEY ("memberId")
          REFERENCES "vendor_users"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "vendor_team_members"`);
  }
}
