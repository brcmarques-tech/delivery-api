import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KAN-254 — `orders.mpPreferenceId` passa a se chamar `orders.pagarmeOrderId`.
 *
 * O nome MENTIA. A coluna guarda o id do pedido no Pagar.me (`or_...`) desde a
 * migração de provedor; "preference" é vocabulário do Mercado Pago, que não é
 * usado há tempos. Quem lê `order.mpPreferenceId` no meio de um fluxo de
 * pagamento tem que descobrir sozinho que aquilo é um id do Pagar.me — e já
 * havia um TODO na entidade admitindo isso.
 *
 * Por que renomear AGORA: não existe banco de produção (nada foi lançado),
 * então o custo é só o do rename. Daqui a seis meses seria uma coluna com
 * dados reais, consultas salvas e integrações apontando para ela.
 *
 * O rename é guardado dos dois lados (origem existe E destino não existe), para
 * ser no-op num banco que já esteja no estado final — a mesma regra de toda
 * migration daqui: rodar duas vezes não pode abortar o boot (KAN-283).
 *
 * `payments.mpPreferenceId` NÃO é tocada: aquela tabela tem as duas colunas
 * (`pagarmeOrderId` e `mpPreferenceId`) com significados diferentes, e mexer
 * nela é outro assunto — não dava para fazer junto sem misturar dois riscos.
 */
export class RenomeiaMpPreferenceId1786800000000 implements MigrationInterface {
  name = 'RenomeiaMpPreferenceId1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'mpPreferenceId'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'pagarmeOrderId'
        ) THEN
          ALTER TABLE "orders" RENAME COLUMN "mpPreferenceId" TO "pagarmeOrderId";
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'pagarmeOrderId'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'mpPreferenceId'
        ) THEN
          ALTER TABLE "orders" RENAME COLUMN "pagarmeOrderId" TO "mpPreferenceId";
        END IF;
      END $$;
    `);
  }
}
