import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Registra QUEM ja recebeu, por recebedor, em vez de depender so do booleano
 * `isSettled`.
 *
 * Motivo: bastava UMA das duas transferencias falhar para `isSettled` voltar a
 * false — mesmo com a outra ja transferida. Isso causava dois problemas opostos:
 *
 *  1. A reversao de repasse faz early-return em `!isSettled`, entao um chargeback
 *     depois de uma liquidacao PARCIAL nao recuperava o dinheiro que JA tinha
 *     saido (a plataforma devolvia 100% ao cliente e perdia o repasse feito).
 *  2. O retry re-enviava AS DUAS transferencias a cada rodada, inclusive a que
 *     ja tinha dado certo, confiando apenas no header Idempotency-Key — que nao
 *     e comportamento documentado do Pagar.me v5 para /transfers.
 *
 * Com estas colunas, cada parte e liquidada e revertida individualmente.
 */
export class AddSettlementPerRecipient1785900000000 implements MigrationInterface {
  name = 'AddSettlementPerRecipient1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "vendorSettledAt" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivererSettledAt" TIMESTAMP`,
    );
    // Pedidos ja liquidados antes desta migration: assume-se que as duas partes
    // sairam, que e o que `isSettled = true` significava ate aqui.
    await queryRunner.query(
      `UPDATE "orders"
          SET "vendorSettledAt" = COALESCE("completedAt", "updatedAt"),
              "delivererSettledAt" = COALESCE("completedAt", "updatedAt")
        WHERE "isSettled" = true
          AND "vendorSettledAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "delivererSettledAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "vendorSettledAt"`,
    );
  }
}
