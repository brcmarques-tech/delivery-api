import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KAN-280 — duas correcoes de autenticacao/identidade:
 *
 * 1. CPF UNICO DE VERDADE. A unicidade era um findOne pela string CRUA antes do
 *    save: "111.444.777-35" nao casava "11144477735" (duas contas com o mesmo
 *    CPF), e dois cadastros simultaneos passavam ambos (TOCTOU). Downstream, o
 *    lookup de recipient do Pagar.me usa CPF limpo e nunca achava quem gravou
 *    com mascara — a plataforma criava um SEGUNDO recipient para o mesmo
 *    documento. Aqui: normaliza as linhas existentes e cria indice unico
 *    parcial nas duas tabelas.
 *
 *    ATENCAO ANTES DO DEPLOY: se a base tiver CPFs que so diferem pela mascara,
 *    a criacao do indice ABORTA a migration (comportamento intencional — melhor
 *    falhar visivel do que escolher sozinha qual conta fica com o CPF). Checar:
 *      SELECT regexp_replace(cpf,'\D','','g') c, count(*) FROM app_users
 *       WHERE cpf IS NOT NULL AND cpf <> '' GROUP BY 1 HAVING count(*) > 1;
 *    (idem vendor_users) e resolver manualmente antes.
 *
 * 2. PRESENCA DE SESSAO. O sessionToken rotaciona e nunca volta a null (e isso
 *    que invalida JWTs no logout/reset), mas o detector de "sessao ativa" era
 *    `sessionToken != null` — permanentemente verdadeiro apos o primeiro login.
 *    Reset de senha ou logout limpo seguido de login legitimo devolvia
 *    ACTIVE_SESSION de um aparelho inexistente. `sessionActive` separa os dois
 *    conceitos. Default false: contas logadas no momento da migration nao
 *    disparam o aviso UMA vez — preferivel a um fantasma permanente.
 */
export class CpfUnicoESessaoAtiva1786100000000 implements MigrationInterface {
  name = 'CpfUnicoESessaoAtiva1786100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // '' vira NULL (o indice parcial ignora NULL; string vazia colidiria)
    await queryRunner.query(
      `UPDATE "app_users" SET cpf = NULLIF(regexp_replace(cpf, '\\D', '', 'g'), '') WHERE cpf IS NOT NULL`,
    );
    await queryRunner.query(
      `UPDATE "vendor_users" SET cpf = NULLIF(regexp_replace(cpf, '\\D', '', 'g'), '') WHERE cpf IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_app_users_cpf" ON "app_users" (cpf) WHERE cpf IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_vendor_users_cpf" ON "vendor_users" (cpf) WHERE cpf IS NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "sessionActive" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "vendor_users" ADD COLUMN IF NOT EXISTS "sessionActive" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vendor_users" DROP COLUMN IF EXISTS "sessionActive"`);
    await queryRunner.query(`ALTER TABLE "app_users" DROP COLUMN IF EXISTS "sessionActive"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_vendor_users_cpf"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_app_users_cpf"`);
    // a normalizacao dos CPFs nao e revertida (nao ha como saber a mascara original)
  }
}
