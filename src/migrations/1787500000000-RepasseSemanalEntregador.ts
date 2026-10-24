import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repasse semanal ao entregador (pago toda quarta): o lote pago, o vínculo de
 * cada frete com o lote e a chave PIX do entregador.
 * Ver RepassesEntregadorService.
 */
export class RepasseSemanalEntregador1787500000000 implements MigrationInterface {
  name = 'RepasseSemanalEntregador1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "repasses_entregador" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "delivererId" uuid NOT NULL,
        "totalCents" integer NOT NULL,
        "quantidade" integer NOT NULL,
        "corte" TIMESTAMP NOT NULL,
        "chavePix" character varying,
        "observacao" text,
        "pagoPor" uuid,
        "pagoEm" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_repasses_entregador" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_repasses_entregador_deliverer" ON "repasses_entregador" ("delivererId")`,
    );
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivererPayoutId" uuid`);
    await queryRunner.query(`ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "chavePix" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_users" DROP COLUMN IF EXISTS "chavePix"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "delivererPayoutId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "repasses_entregador"`);
  }
}
