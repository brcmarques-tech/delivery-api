import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Comissão gravada em pedido pago em DINHEIRO (ON_DELIVERY).
 *
 * Pela regra de 16/10/2026 (ver OrdersService.completeOrderWithPayment), a
 * plataforma não cobra comissão de dinheiro com retirada ou frota própria — e
 * dinheiro só existe nesses dois casos. Mesmo assim o pedido gravava a comissão
 * do plano, e o financeiro do superadmin a somava como receita da plataforma e
 * punha o pedido em "a receber" da loja.
 *
 * O código agora grava zero. Esta migration zera o que já foi gravado. Só o
 * VALOR: o `commissionPercent` fica, e é com ele que se refaz a conta se um
 * dia a regra mudar (commissionAmount = (subtotal - discount) * percent / 100).
 */
export class ZeraComissaoDeDinheiro1787300000000 implements MigrationInterface {
  name = 'ZeraComissaoDeDinheiro1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "orders"
          SET "commissionAmount" = 0
        WHERE "paymentMethod" = 'ON_DELIVERY'
          AND COALESCE("commissionAmount", 0) <> 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "orders"
          SET "commissionAmount" = ROUND((("subtotal" - COALESCE("discount", 0)) * "commissionPercent") / 100, 2)
        WHERE "paymentMethod" = 'ON_DELIVERY'
          AND COALESCE("commissionAmount", 0) = 0
          AND COALESCE("commissionPercent", 0) <> 0`,
    );
  }
}
