import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sessão da loja web separada da sessão do app: o cliente pode ficar logado no
 * site e no app ao mesmo tempo. Ver AuthService.signWithSession (canal 'web').
 */
export class SessaoSeparadaDoSite1787600000000 implements MigrationInterface {
  name = 'SessaoSeparadaDoSite1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "webSessionToken" character varying`);
    await queryRunner.query(`ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "webSessionActive" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_users" DROP COLUMN IF EXISTS "webSessionActive"`);
    await queryRunner.query(`ALTER TABLE "app_users" DROP COLUMN IF EXISTS "webSessionToken"`);
  }
}
