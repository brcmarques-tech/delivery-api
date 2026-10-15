/**
 * Conta as linhas REALMENTE afetadas por um `UPDATE ... RETURNING`.
 *
 * O `manager.query()` do TypeORM com driver Postgres NAO devolve a lista de
 * linhas para UPDATE/INSERT/DELETE: devolve `[linhas, quantidade]` — um array de
 * comprimento 2 **sempre**, tanto faz se casou 0 ou 50 linhas:
 *
 *   0 linhas -> [[], 0]
 *   1 linha  -> [[{ id: '...' }], 1]
 *
 * Todo o sistema de claims atomicos (idempotencia de estorno, liquidacao,
 * restauracao de estoque, transicao de status, contador de cupom) checava
 * `resultado.length === 0` para saber se havia PERDIDO a disputa. Como esse
 * comprimento e 2 nos dois casos, a condicao NUNCA era verdadeira: todos os
 * guards se comportavam como se sempre tivessem ganhado o claim. Na pratica a
 * protecao contra execucao dupla nao existia — exatamente o oposto do que os
 * comentarios desses trechos afirmam.
 *
 * Esta funcao normaliza as duas formas possiveis (com e sem o par
 * `[linhas, quantidade]`), para nao depender da versao do driver.
 */
export function linhasAfetadas(resultado: unknown): number {
  if (!Array.isArray(resultado)) return 0;
  // Forma [linhas, quantidade] do driver Postgres em UPDATE/INSERT/DELETE
  if (
    resultado.length === 2 &&
    Array.isArray(resultado[0]) &&
    typeof resultado[1] === 'number'
  ) {
    return resultado[1];
  }
  // Forma simples (SELECT, ou drivers que devolvem so as linhas)
  return resultado.length;
}

/** Açúcar: o claim foi ganho (afetou ao menos uma linha)? */
export function claimGanho(resultado: unknown): boolean {
  return linhasAfetadas(resultado) > 0;
}
