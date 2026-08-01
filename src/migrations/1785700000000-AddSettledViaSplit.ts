import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders.settledViaSplit` (adicionada em cda381f para corrigir o estorno que
 * nao revertia repasse no caminho do antifraude).
 *
 * CRITICO: producao roda com `synchronize: false` e so aplica `src/migrations/*`.
 * A coluna foi adicionada na entity SEM migration — no proximo deploy o SELECT
 * gerado pelo TypeORM para `Order` passaria a incluir "settledViaSplit", e TODA
 * leitura de pedido (myOrders, storeOrders, os 6 schedulers, endpoints n8n)
 * quebraria com "column does not exist". Alem disso o UPDATE do settlement
 * falharia DEPOIS de a captura com split ja ter acontecido no Pagar.me —
 * cobranca capturada e pedido nao liquidado.
 */
export class AddSettledViaSplit1785700000000 implements MigrationInterface {
  name = 'AddSettledViaSplit1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "settledViaSplit" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "settledViaSplit"`,
    );
  }
}
