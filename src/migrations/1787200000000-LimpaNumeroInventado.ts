import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * O "S/N" que a API inventava nos endereços salvos automaticamente.
 *
 * Ao criar um pedido, a API salva o endereço digitado no checkout, quebrando o
 * texto por vírgulas. Sem vírgula — "Rua Andrade Neves 1500 Pelotas", o jeito
 * mais comum de digitar — o número caía em 'S/N', e o app mostrava
 * "Rua Andrade Neves 1500 Pelotas, S/N, , /".
 *
 * O código agora grava vazio. Esta migration limpa o que já foi gravado, e só
 * onde o 'S/N' é com certeza inventado: endereço com bairro, cidade e UF
 * vazios — exatamente o que esse salvamento automático produz. Endereço
 * cadastrado pela tela de endereços (que exige cidade) não é tocado, e lá
 * "S/N" pode ser legítimo.
 */
export class LimpaNumeroInventado1787200000000 implements MigrationInterface {
  name = 'LimpaNumeroInventado1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "addresses"
          SET "number" = ''
        WHERE "number" = 'S/N'
          AND COALESCE("neighborhood", '') = ''
          AND COALESCE("city", '') = ''
          AND COALESCE("state", '') = ''`,
    );
  }

  public async down(): Promise<void> {
    // Sem volta: não há como saber quais linhas eram 'S/N' inventado depois
    // de limpas, e recolocar o lixo não serve a ninguém.
  }
}
