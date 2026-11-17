import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KAN-326: soft delete nos dados de negócio (loja, categoria, serviço, promoção,
 * cupom, endereço, cartão salvo, horários). Unicidade passa a valer só entre os
 * não excluídos, para dar para recriar com o mesmo slug/código.
 */
export class SoftDeleteDadosDeNegocio1787700000000 implements MigrationInterface {
  name = 'SoftDeleteDadosDeNegocio1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const tabela of ['stores', 'categories', 'services', 'promotions', 'coupons', 'addresses', 'saved_cards', 'schedules']) {
      await queryRunner.query(`ALTER TABLE "${tabela}" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP`);
    }
    // restrições únicas antigas (nomes variam por ambiente: remove pela definição)
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT c.conrelid::regclass::text AS tabela, c.conname
            FROM pg_constraint c
           WHERE c.contype = 'u'
             AND (
               (c.conrelid = 'stores'::regclass AND pg_get_constraintdef(c.oid) IN ('UNIQUE (slug)', 'UNIQUE ("whatsappNumber")'))
               OR (c.conrelid = 'coupons'::regclass AND pg_get_constraintdef(c.oid) = 'UNIQUE (code, "storeId")')
               OR (c.conrelid = 'schedules'::regclass AND pg_get_constraintdef(c.oid) = 'UNIQUE ("storeId", "dayOfWeek")')
             )
        LOOP
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tabela, r.conname);
        END LOOP;
      END $$;
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_stores_slug_ativo" ON "stores" ("slug") WHERE "deletedAt" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_stores_whatsapp_ativo" ON "stores" ("whatsappNumber") WHERE "deletedAt" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_coupons_code_store_ativo" ON "coupons" ("code", "storeId") WHERE "deletedAt" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_schedules_store_dia_ativo" ON "schedules" ("storeId", "dayOfWeek") WHERE "deletedAt" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_schedules_store_dia_ativo"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_coupons_code_store_ativo"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_stores_whatsapp_ativo"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_stores_slug_ativo"`);
    for (const tabela of ['stores', 'categories', 'services', 'promotions', 'coupons', 'addresses', 'saved_cards', 'schedules']) {
      await queryRunner.query(`ALTER TABLE "${tabela}" DROP COLUMN IF EXISTS "deletedAt"`);
    }
  }
}
