import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KAN-325: agendamento pago por PIX passa a ser cobrado com split (loja +
 * plataforma). A coluna marca isso para a liquidação não tentar /transfers.
 */
export class AgendamentoPixComSplit1787900000000 implements MigrationInterface {
  name = 'AgendamentoPixComSplit1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "settledViaSplit" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "appointments" DROP COLUMN IF EXISTS "settledViaSplit"`);
  }
}
