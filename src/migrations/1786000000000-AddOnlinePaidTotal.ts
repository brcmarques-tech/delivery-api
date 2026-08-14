import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Registra quanto o cliente JA pagou/autorizou online, para o ajuste de peso
 * nao descolar a cobranca do valor real.
 *
 * Motivo: adjustItemWeight recalcula `total` livremente depois do PIX pago ou
 * da pre-autorizacao do cartao, e nada comparava o total novo com o valor
 * cobrado. Tres consequencias:
 *
 *  1. CARTAO, peso maior: a captura pedia mais do que a pre-autorizacao — o
 *     Pagar.me recusa, o retry repete a captura invalida por 48h e vendedor e
 *     entregador NUNCA recebem.
 *  2. PIX pago, peso menor: nao existia reembolso parcial — a diferenca ficava
 *     com a plataforma, em silencio.
 *  3. PIX pago, peso maior: os repasses saiam sobre o total novo, maior que o
 *     valor em custodia — a plataforma pagava a diferenca do proprio bolso.
 *
 * `onlinePaidTotal` e preenchido no PRIMEIRO ajuste de peso (o unico ponto que
 * muda `total` pos-criacao), entao nao precisa de backfill: null significa
 * "total nunca mudou", e nesse caso o proprio `total` e o valor pago.
 * `overpaidRefundedAt` e a guarda de idempotencia do reembolso parcial (mesmo
 * papel dos vendorSettledAt/delivererSettledAt para as transferencias).
 */
export class AddOnlinePaidTotal1786000000000 implements MigrationInterface {
  name = 'AddOnlinePaidTotal1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "onlinePaidTotal" numeric(10,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "overpaidRefundedAt" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "overpaidRefundedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "onlinePaidTotal"`,
    );
  }
}
