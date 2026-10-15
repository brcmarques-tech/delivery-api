import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Torna rastreável o repasse de entregador retido no PIX.
 *
 * Com o split-on-charge (C1), o entregador NÃO entra na divisão da cobrança —
 * ele só é conhecido no READY, depois de o pagamento já ter sido dividido. O
 * frete fica retido na plataforma e o settle marcava `[DELIVERER_PAYABLE]` nas
 * NOTAS do pedido.
 *
 * Nota em texto livre não dá para somar, filtrar nem dar baixa: na prática o
 * dinheiro devido ao entregador ficava invisível. Estas colunas tornam o
 * passivo uma informação de primeira classe — consultável, somável e baixável.
 *
 * Backfill: varre as notas existentes e extrai o valor já marcado, para que os
 * pedidos anteriores a esta migration também apareçam no relatório.
 */
export class AddDelivererPayable1786400000000 implements MigrationInterface {
  name = 'AddDelivererPayable1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivererPayableCents" INTEGER`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivererPayablePaidAt" TIMESTAMP`,
    );
    // Backfill a partir do marcador em notes: "[DELIVERER_PAYABLE] R$ 12.34 ..."
    await queryRunner.query(`
      UPDATE "orders"
         SET "delivererPayableCents" = ROUND(
               REPLACE(
                 SUBSTRING(notes FROM '\[DELIVERER_PAYABLE\] R\$ ([0-9]+[.,][0-9]{2})'),
                 ',', '.'
               )::numeric * 100
             )
       WHERE notes LIKE '%[DELIVERER_PAYABLE%'
         AND "delivererPayableCents" IS NULL
         AND SUBSTRING(notes FROM '\[DELIVERER_PAYABLE\] R\$ ([0-9]+[.,][0-9]{2})') IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "delivererPayablePaidAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "delivererPayableCents"`,
    );
  }
}
