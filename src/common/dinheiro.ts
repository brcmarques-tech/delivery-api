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

/** Mesmo cálculo, de reais para reais. */
export function percentualEmReais(reais: number, percentual: number): number {
  return percentualEmCentavos(Math.round(reais * 100), percentual) / 100;
}
