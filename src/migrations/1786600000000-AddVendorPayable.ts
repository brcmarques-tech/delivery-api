import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Torna rastreável o repasse de LOJISTA retido na plataforma.
 *
 * Irmã da AddDelivererPayable, e pelo mesmo motivo: passivo que mora em texto
 * livre não dá para somar, filtrar nem dar baixa. Na prática o dinheiro devido
 * fica invisível.
 *
 * O caso do lojista nasceu em 15/10/2026, ao tratar o repasse bloqueado pelo
 * allowlist de IP do Pagar.me (KAN-299). Quando a transferência é recusada por
 * configuração NOSSA, o valor passou a ser registrado como passivo em vez de
 * ficar 48h em retry contra um 401 que nunca muda. Só que, sem coluna, ele
 * ficou apenas como marcador `[VENDOR_PAYABLE]` em `notes` — consultável por
 * LIKE, não somável.
 *
 * Eu adiei esta coluna de propósito naquele commit, para não abrir migration no
 * meio de uma auditoria, e registrei que ela deveria vir junto da tela de
 * passivos. É o que esta migration faz.
 *
 * ATENÇÃO À ASSIMETRIA COM O ENTREGADOR, que é deliberada:
 *
 *   `delivererSettledAt` É marcado quando o passivo do entregador é criado,
 *   porque naquele caminho (PIX com split-on-charge) o repasse dele nunca foi
 *   tentado — o split já aconteceu sem ele.
 *
 *   `vendorSettledAt` NÃO é marcado. O lojista deveria ter recebido e não
 *   recebeu; marcar como liquidado esconderia a dívida.
 *
 * Backfill: varre as notas e extrai o valor já marcado, para que os pedidos
 * anteriores a esta migration também apareçam no relatório.
 */
export class AddVendorPayable1786600000000 implements MigrationInterface {
  name = 'AddVendorPayable1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "vendorPayableCents" INTEGER`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "vendorPayablePaidAt" TIMESTAMP`,
    );
    // Backfill a partir do marcador em notes: "[VENDOR_PAYABLE] R$ 12.34 ..."
    await queryRunner.query(`
      UPDATE "orders"
         SET "vendorPayableCents" = ROUND(
               REPLACE(
                 SUBSTRING(notes FROM '\[VENDOR_PAYABLE\] R\$ ([0-9]+[.,][0-9]{2})'),
                 ',', '.'
               )::numeric * 100
             )
       WHERE notes LIKE '%[VENDOR_PAYABLE%'
         AND "vendorPayableCents" IS NULL
         AND SUBSTRING(notes FROM '\[VENDOR_PAYABLE\] R\$ ([0-9]+[.,][0-9]{2})') IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "vendorPayablePaidAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "vendorPayableCents"`,
    );
  }
}
