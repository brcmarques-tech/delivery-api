import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KAN-12 — cupom NOMINAL e rastro de origem.
 *
 * Por que o cupom de fidelidade precisa de dono: um cupom é identificado pelo
 * CÓDIGO. Sem dono, o prêmio que o cliente recebeu por comprar dez vezes vale
 * para quem souber o código — basta um print em grupo de WhatsApp e a
 * recompensa (que sai do bolso da loja) vai para qualquer um, inclusive para
 * quem nunca comprou. `appUserId` amarra o cupom a quem ganhou.
 *
 * `origem` separa o que a LOJA criou do que a PLATAFORMA gerou. Sem isso, o
 * lojista abre a lista de cupons e encontra códigos que ele não criou, sem
 * saber de onde vieram — e os relatórios misturam promoção dele com prêmio de
 * fidelidade.
 *
 * Idempotente, como todas as outras (KAN-283).
 */
export class CupomDeFidelidade1786900000000 implements MigrationInterface {
  name = 'CupomDeFidelidade1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "appUserId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "origem" character varying NOT NULL DEFAULT 'VENDOR'`,
    );
    // Índice: a validação do cupom consulta por (código, loja) e, quando o
    // cupom é nominal, confere o dono; a tela de fidelidade lista por cliente.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_coupons_appUserId" ON "coupons" ("appUserId")`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "coupons"
          ADD CONSTRAINT "FK_coupons_appUser"
          FOREIGN KEY ("appUserId") REFERENCES "app_users"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "coupons" DROP CONSTRAINT IF EXISTS "FK_coupons_appUser"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_coupons_appUserId"`);
    await queryRunner.query(`ALTER TABLE "coupons" DROP COLUMN IF EXISTS "origem"`);
    await queryRunner.query(`ALTER TABLE "coupons" DROP COLUMN IF EXISTS "appUserId"`);
  }
}
