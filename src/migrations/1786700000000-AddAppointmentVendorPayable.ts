import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * O mesmo passivo de lojista, agora em `appointments`.
 *
 * Terceira e última das irmãs (AddDelivererPayable, AddVendorPayable, esta).
 * O motivo é o de sempre: passivo que mora em texto livre não dá para somar,
 * filtrar nem dar baixa, e por isso o dinheiro devido fica invisível.
 *
 * O caminho de PEDIDO ganhou esse tratamento em 15/10/2026; a cópia de
 * AGENDAMENTO ficou de fora e só apareceu ao procurar pela mesma classe de bug
 * no dia seguinte. É o clássico conserto que pega um lado só — e o lado que
 * ficou era pior, porque o retry de agendamento tem janela de 48h: ao fim
 * dela o agendamento saía da fila com o dinheiro na plataforma e nenhum
 * registro de que havia dívida.
 *
 * Backfill a partir do marcador em notes, igual às outras duas.
 */
export class AddAppointmentVendorPayable1786700000000 implements MigrationInterface {
  name = 'AddAppointmentVendorPayable1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "vendorPayableCents" INTEGER`,
    );
    await queryRunner.query(
      `ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "vendorPayablePaidAt" TIMESTAMP`,
    );
    await queryRunner.query(`
      UPDATE "appointments"
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
      `ALTER TABLE "appointments" DROP COLUMN IF EXISTS "vendorPayablePaidAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "appointments" DROP COLUMN IF EXISTS "vendorPayableCents"`,
    );
  }
}
