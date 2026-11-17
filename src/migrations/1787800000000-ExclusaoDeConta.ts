import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KAN-326 / LGPD: marca quando a conta foi excluída (e anonimizada) a pedido do
 * titular. Ver ContaService.excluirMinhaConta.
 */
export class ExclusaoDeConta1787800000000 implements MigrationInterface {
  name = 'ExclusaoDeConta1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "contaExcluidaEm" TIMESTAMP`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_users" DROP COLUMN IF EXISTS "contaExcluidaEm"`);
  }
}
