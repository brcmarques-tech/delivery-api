import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Frete grátis só existe com a frota própria da loja (ver
 * StoresService.freteGratisSoComFrotaPropria). Loja com entregador do app que
 * ficou com frete grátis salvo — de antes de trocar o modo de entrega — dava
 * corrida de R$ 0,00 ao entregador. Esta migration desliga esse resto.
 */
export class FreteGratisSoComFrotaPropria1787400000000 implements MigrationInterface {
  name = 'FreteGratisSoComFrotaPropria1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "stores"
          SET "freeDelivery" = false, "freeDeliveryAbove" = NULL
        WHERE "hasOwnDelivery" = false
          AND ("freeDelivery" = true OR "freeDeliveryAbove" IS NOT NULL)`,
    );
  }

  public async down(): Promise<void> {
    // Sem volta: o frete grátis com entregador do app era o defeito.
  }
}
