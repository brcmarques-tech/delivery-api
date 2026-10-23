/**
 * Ciclo do repasse semanal ao entregador (modelo iFood, decisão do Bruno em
 * 23/10/2026): as entregas concluídas de SEGUNDA a DOMINGO são pagas na QUARTA
 * seguinte.
 *
 * Por que existe: no PIX o entregador não entra no split (só é conhecido
 * depois do pagamento) e a transferência plataforma → recebedor não é uma
 * operação que o Pagar.me v5 aceite daqui. O frete dele fica com a plataforma
 * e é pago por fora, em lote, toda quarta.
 *
 * As contas são no horário de Brasília (UTC−3, sem horário de verão desde
 * 2019), independentes do fuso do servidor.
 */
const BRASILIA_MS = 3 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

/** Segunda-feira 00:00 (Brasília) da semana de `d`, como instante UTC. */
export function inicioDaSemana(d: Date): Date {
  const local = new Date(d.getTime() - BRASILIA_MS); // campos UTC = hora de Brasília
  const desdeSegunda = (local.getUTCDay() + 6) % 7; // 0 = segunda ... 6 = domingo
  const segunda = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - desdeSegunda);
  return new Date(segunda + BRASILIA_MS);
}

/** Quarta-feira (00:00 Brasília) em que é paga a entrega concluída em `conclusao`. */
export function dataDePagamento(conclusao: Date): Date {
  return new Date(inicioDaSemana(conclusao).getTime() + 9 * DIA_MS); // segunda + 7 + 2
}

/**
 * Corte do fechamento feito em `agora`: entra o que foi concluído ANTES da
 * segunda-feira desta semana (ou seja, até o domingo que passou). O que foi
 * concluído nesta semana fica para a próxima quarta.
 */
export function corteDoFechamento(agora: Date): Date {
  return inicioDaSemana(agora);
}

/** "2026-10-28" no calendário de Brasília. */
export function diaEmBrasilia(d: Date): string {
  return new Date(d.getTime() - BRASILIA_MS).toISOString().slice(0, 10);
}
