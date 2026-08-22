import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Perf (F5 — auditoria de performance do app, 2026-07-30):
 * `orders.status` e o filtro mais quente da tabela — availableDeliveries
 * (status = READY, tela de entregas do app), schedulers de expiracao e
 * auto-confirmacao, e os paineis filtram por ele constantemente. Sem indice,
 * cada uma dessas consultas fazia sequential scan crescendo com o volume de
 * pedidos. Em dev o synchronize cria o indice sozinho (entity ganhou @Index);
 * esta migration garante o mesmo em producao.
 */
export class AddOrderStatusIndex1784880000000 implements MigrationInterface {
  name = 'AddOrderStatusIndex1784880000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_orders_status" ON "orders" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orders_status"`);
  }
}
