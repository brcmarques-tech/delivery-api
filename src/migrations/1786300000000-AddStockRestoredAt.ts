import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Guarda de idempotência da restauração de estoque+cupom no cancelamento
 * (auditoria de pagamentos 2026-08-23).
 *
 * Bug: `restoreStockAndCoupon` não tinha claim próprio. O claim atômico
 * anti-estorno-duplo protege só o ESTORNO, não a RESTAURAÇÃO. Dois fluxos de
 * cancelamento concorrentes (ex.: o cliente cancela pelo app exatamente quando
 * `expirePendingOrders` varre o mesmo pedido) — um ganha o claim do estorno, o
 * outro recebe exceção, ela é engolida, ele relê o status já terminal do banco e
 * chama `restoreStockAndCoupon` também. Resultado: estoque incrementado 2x
 * (estoque fantasma -> oversell na sequência) e `decrementUsage` do cupom 2x.
 *
 * Backfill: pedidos já cancelados/rejeitados/expirados no passado já tiveram (ou
 * não) o estoque restaurado uma vez; marcá-los como restaurados agora só impede
 * uma restauração FUTURA indevida sobre eles. Preenchemos `stockRestoredAt` dos
 * terminais antigos com o `updatedAt` para que nenhum fluxo tardio (ex.: um
 * `charge.refunded` que chegue depois de dias) volte a mexer no estoque deles.
 */
export class AddStockRestoredAt1786300000000 implements MigrationInterface {
  name = 'AddStockRestoredAt1786300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "stockRestoredAt" TIMESTAMP`,
    );
    // Backfill dos pedidos já terminais: considera a restauração como já ocorrida
    // (uma vez), travando qualquer restauração tardia sobre eles.
    await queryRunner.query(
      `UPDATE "orders" SET "stockRestoredAt" = "updatedAt"
         WHERE "stockRestoredAt" IS NULL
           AND status IN ('CANCELLED','REJECTED','EXPIRED')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "stockRestoredAt"`,
    );
  }
}
