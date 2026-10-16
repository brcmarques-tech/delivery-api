import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KAN-13 — identidade visual da loja.
 *
 * A loja já escolhe logo e banner; a cor continuava sendo a da plataforma. Para
 * quem tem marca (e a maioria tem, nem que seja a cor do letreiro), a tela do
 * app não parece a loja dele.
 *
 * `productLayout` entra junto porque é a outra metade do mesmo pedido: padaria
 * e loja de roupa não mostram produto do mesmo jeito — uma quer lista densa,
 * a outra quer foto grande.
 *
 * NULO = usa o tema da plataforma. Ninguém é obrigado a escolher cor, e loja
 * antiga continua exatamente como está.
 */
export class VisualDaLoja1787100000000 implements MigrationInterface {
  name = 'VisualDaLoja1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "primaryColor" character varying(9)`,
    );
    await queryRunner.query(
      `ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "backgroundColor" character varying(9)`,
    );
    await queryRunner.query(
      `ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "textColor" character varying(9)`,
    );
    await queryRunner.query(
      `ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "productLayout" character varying(10)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stores" DROP COLUMN IF EXISTS "productLayout"`);
    await queryRunner.query(`ALTER TABLE "stores" DROP COLUMN IF EXISTS "textColor"`);
    await queryRunner.query(`ALTER TABLE "stores" DROP COLUMN IF EXISTS "backgroundColor"`);
    await queryRunner.query(`ALTER TABLE "stores" DROP COLUMN IF EXISTS "primaryColor"`);
  }
}
