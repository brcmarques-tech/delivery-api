/**
 * Quando o entregador pode SOMAR mais uma corrida às que já tem.
 *
 * A regra era "uma entrega por vez". Agora ele pode levar várias numa ida só,
 * desde que:
 *  - sejam todas da MESMA LOJA (o mesmo ponto de coleta) — corrida de outra
 *    loja o obrigaria a atravessar a cidade com pedido na mochila;
 *  - ele ainda NÃO tenha saído da loja: todas as que já tem estão esperando
 *    coleta (READY). Depois que coletou e está a caminho, somar outra daquela
 *    loja não faz sentido — ele já foi embora.
 *
 * Sem limite de quantidade de propósito: quem decide quantas cabem na moto é o
 * entregador, e a vez exclusiva da cascata já entrega uma corrida de cada vez.
 *
 * Devolve o motivo para NÃO somar (texto para o entregador), ou null se pode.
 */
export interface EntregaEmAndamento {
  storeId: string;
  status: string;
}

export function motivoParaNaoSomar(
  emAndamento: EntregaEmAndamento[],
  storeIdDaNova: string,
): string | null {
  if (emAndamento.length === 0) return null;
  if (emAndamento.some((e) => e.storeId !== storeIdDaNova)) {
    return 'Você já tem uma entrega de outra loja. Finalize-a antes de aceitar esta.';
  }
  if (emAndamento.some((e) => e.status !== 'READY')) {
    return 'Você já saiu da loja com uma entrega. Finalize-a antes de aceitar outra.';
  }
  return null;
}

/** SQL das entregas que ainda prendem o entregador (pedido vivo, não entregue). */
export const SQL_ENTREGAS_EM_ANDAMENTO = `
  SELECT o."storeId" AS "storeId", o.status AS status
    FROM deliveries d
    JOIN orders o ON o.id = d."orderId"
   WHERE d."delivererId" = $1
     AND d."deliveredAt" IS NULL
     AND o.status NOT IN ('COMPLETED','CANCELLED','REJECTED','EXPIRED','DISPUTED')`;
