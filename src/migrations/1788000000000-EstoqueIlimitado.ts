import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Produto sem controle de estoque ("estoque 0 = ilimitado" no painel). Os que já
 * estão com estoque 0 e disponíveis foram cadastrados assim pelo painel e passam
 * a ilimitados; esgotados (estoque controlado que zerou) estão indisponíveis e
 * continuam como estão.
 */
export class EstoqueIlimitado1788000000000 implements MigrationInterface {
  name = 'EstoqueIlimitado1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "estoqueIlimitado" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`UPDATE "products" SET "estoqueIlimitado" = true WHERE stock = 0 AND "isAvailable" = true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "estoqueIlimitado"`);
  }
}
