/**
 * Percentual de um valor em dinheiro, arredondado ao centavo (meio centavo
 * para cima).
 *
 * A conta era feita em reais com ponto flutuante — `Math.round(x * p / 100 *
 * 100) / 100` — e o meio centavo caía para BAIXO quando o produto não tinha
 * representação exata: 5% de R$ 2,90 = 0,145 virava 0,14; 5% de R$ 20,10 =
 * 1,005 virava 1,00. Varrendo subtotais de R$ 0,01 a R$ 2.000 nos planos de 5%
 * e 2%, eram 843 casos com um centavo a menos — sempre contra a plataforma.
 *
 * Aqui a conta vai em CENTAVOS inteiros e o ruído do float é cortado (toFixed)
 * antes do arredondamento, o que também cobre percentual quebrado (redução de
 * comissão temporária).
 */
export function percentualEmCentavos(centavos: number, percentual: number): number {
  return Math.round(Number(((centavos * percentual) / 100).toFixed(6)));
}

/**
 * Quem paga a taxa do meio de pagamento (MDR do cartão, tarifa do PIX) num
 * split: a LOJA. Decisão do Bruno em 23/10/2026: "não tem que ter prejuízo para
 * a plataforma nunca".
 *
 * Antes a regra da plataforma levava `charge_processing_fee` — ela pagava a
 * taxa inteira do pedido com a fatia dela. Medido no sandbox: ~4,49% do total
 * no cartão. Com comissão de 2% (PRO) ou 0% (PREMIUM) a plataforma recebia
 * menos do que pagava de taxa e cada venda no cartão dava prejuízo (pedido de
 * R$ 38,99 no PRO: recebeu R$ 0,87, pagou R$ 1,75).
 *
 * O entregador nunca paga taxa. Sem regra da loja (não deveria acontecer num
 * pedido online), cai na plataforma, para o split não sair sem pagador — o
 * gateway recusaria.
 */
export function taxaPorContaDaLoja(
  regras: Array<{ recipient_id: string; options?: Record<string, any> }>,
  recebedorDaLoja: string | null | undefined,
  recebedorDaPlataforma: string | null | undefined,
): void {
  const pagador =
    regras.find((r) => recebedorDaLoja && r.recipient_id === recebedorDaLoja) ??
    regras.find((r) => recebedorDaPlataforma && r.recipient_id === recebedorDaPlataforma);
  for (const r of regras) {
    const ehPagador = r === pagador;
    r.options = { ...(r.options || {}), charge_processing_fee: ehPagador, charge_remainder_fee: ehPagador };
  }
}

/** Mesmo cálculo, de reais para reais. */
export function percentualEmReais(reais: number, percentual: number): number {
  return percentualEmCentavos(Math.round(reais * 100), percentual) / 100;
}
