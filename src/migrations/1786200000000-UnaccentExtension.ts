import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Busca insensivel a acento (auditoria: trio vitrine/busca). "pao" precisa
 * achar "pão" — as buscas de produto/catalogo passam a usar unaccent() nos dois
 * lados do LIKE. A extensao e do contrib padrao do Postgres (sem pacote extra).
 *
 * Requer permissao de CREATE EXTENSION no banco (superuser ou dono com
 * privilegio). Se o provedor gerenciado exigir habilitar por painel, rodar
 * `CREATE EXTENSION unaccent;` manualmente antes do deploy.
 */
export class UnaccentExtension1786200000000 implements MigrationInterface {
  name = 'UnaccentExtension1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // nao derruba a extensao no down: outros objetos podem passar a depender
    // dela e o custo de mante-la e zero.
  }
}
