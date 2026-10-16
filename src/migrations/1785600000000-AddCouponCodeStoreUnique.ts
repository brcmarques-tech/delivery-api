import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unicidade de (code, storeId) em cupons.
 *
 * BUG QUE ISTO FECHA NA RAIZ: `code` nunca teve constraint no banco — a
 * unicidade por loja era so uma checagem read-then-write no service (racy), e
 * o `update` do cupom nem re-checava. Isso permitia dois cupons com o mesmo
 * codigo na mesma loja, e foi o que tornou possivel o bug do contador de usos
 * (o incremento por `code` sem escopo de loja, ja corrigido em cda381f).
 */
export class AddCouponCodeStoreUnique1785600000000 implements MigrationInterface {
  name = 'AddCouponCodeStoreUnique1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // KAN-283 [ALTO] — DEDUPLICAR ANTES DE CRIAR O ÍNDICE.
    //
    // Antes desta migration nao havia constraint nenhuma: a unicidade por loja
    // era um read-then-write no service, racy por construcao. Ou seja,
    // duplicata em (code, storeId) era POSSIVEL — e o proprio comentario
    // original desta migration admitia isso.
    //
    // O que acontecia com UMA duplicata na base: o CREATE UNIQUE INDEX falha,
    // o `migrationsRun` do boot aborta e a API INTEIRA nao sobe. Um cupom
    // repetido derrubava o deploy, e a descoberta seria no deploy.
    //
    // Entao: renomeia as duplicatas (mantendo a MAIS ANTIGA com o codigo
    // original) e deixa rastro de que foi a migration que mexeu. Renomear em
    // vez de apagar porque cupom tem historico de uso preso nele; o lojista
    // ve "PROMO10_DUP_<id>" e decide o que fazer, em vez de perder o registro.
    await queryRunner.query(`
      UPDATE coupons SET code = code || '_DUP_' || id
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY code, "storeId" ORDER BY "createdAt", id
                 ) AS rn
          FROM coupons
        ) t WHERE t.rn > 1
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_coupons_code_store" ON "coupons" ("code", "storeId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_coupons_code_store"`);
  }
}
