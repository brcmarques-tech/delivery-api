import { percentualEmCentavos, percentualEmReais } from './dinheiro';

describe('percentual em dinheiro — meio centavo arredonda para cima', () => {
  it.each([
    // casos que a conta em float arredondava para BAIXO
    [2.9, 5, 0.15],
    [5.7, 5, 0.29],
    [7.25, 2, 0.15],
    [20.1, 5, 1.01],
    [20.3, 5, 1.02],
    // casos que já davam certo continuam certos
    [37.9, 5, 1.9],
    [37.9, 2, 0.76],
    [100, 0, 0],
    [0.01, 5, 0],
  ])('%s × %s%% = %s', (reais, pct, esperado) => {
    expect(percentualEmReais(reais, pct)).toBe(esperado);
  });

  it('varredura de R$ 0,01 a R$ 2.000 nos planos de 5% e 2%: nenhum centavo errado', () => {
    for (let centavos = 1; centavos <= 200000; centavos++) {
      for (const pct of [5, 2]) {
        const certo = Math.floor((centavos * pct + 50) / 100); // meio para cima, em inteiros
        expect(percentualEmCentavos(centavos, pct)).toBe(certo);
      }
    }
  });

  it('comissão de entrega de 10% sobre o frete', () => {
    expect(percentualEmCentavos(109, 10)).toBe(11);
    expect(percentualEmCentavos(105, 10)).toBe(11);
    expect(percentualEmCentavos(98, 10)).toBe(10);
  });

  it('percentual quebrado (redução temporária de comissão) não acumula ruído', () => {
    expect(percentualEmCentavos(10000, 3.5)).toBe(350);
    expect(percentualEmCentavos(3333, 1.5)).toBe(50);
  });
});
