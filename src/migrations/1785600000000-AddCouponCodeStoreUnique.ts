import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unicidade de (code, storeId) em cupons.
 *
 * BUG QUE ISTO FECHA NA RAIZ: `code` nunca teve constraint no banco — a
 * unicidade por loja era so uma checagem read-then-write no service (racy), e
 * o `update` do cupom nem re-checava. Isso permitia dois cupons com o mesmo
 * codigo na mesma loja, e foi o que tornou possivel o bug do contador de usos
 * (o incremento por `code` sem escopo de loja, ja corrigido em cda381f).
 */
export class AddCouponCodeStoreUnique1785600000000 implements MigrationInterface {
  name = 'AddCouponCodeStoreUnique1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_coupons_code_store" ON "coupons" ("code", "storeId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_coupons_code_store"`);
  }
}
