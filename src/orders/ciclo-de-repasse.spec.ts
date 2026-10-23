import { corteDoFechamento, dataDePagamento, diaEmBrasilia, inicioDaSemana } from './ciclo-de-repasse';

// Instantes em Brasília escritos com o fuso explícito, para o teste não
// depender do fuso da máquina. Outubro/2026: dia 19 é segunda, 25 domingo,
// 26 segunda, 28 quarta.
const br = (iso: string) => new Date(`${iso}-03:00`);

describe('ciclo do repasse semanal — segunda a domingo, paga na quarta', () => {
  it.each([
    ['segunda 00:00', '2026-10-19T00:00:00', '2026-10-28'],
    ['quarta à tarde', '2026-10-21T15:30:00', '2026-10-28'],
    ['domingo 23:59', '2026-10-25T23:59:59', '2026-10-28'],
    ['segunda seguinte 00:00', '2026-10-26T00:00:00', '2026-11-04'],
  ])('entrega concluída %s é paga em %s', (_n, quando, quarta) => {
    expect(diaEmBrasilia(dataDePagamento(br(quando)))).toBe(quarta);
  });

  it('domingo 22h em Brasília ainda é a mesma semana, mesmo já sendo segunda em UTC', () => {
    // 2026-10-26T01:00Z = domingo 22:00 em Brasília
    const d = new Date('2026-10-26T01:00:00Z');
    expect(diaEmBrasilia(inicioDaSemana(d))).toBe('2026-10-19');
    expect(diaEmBrasilia(dataDePagamento(d))).toBe('2026-10-28');
  });

  it('o fechamento de quarta 28/10 pega o que foi até domingo 25/10', () => {
    const corte = corteDoFechamento(br('2026-10-28T10:00:00'));
    expect(br('2026-10-25T23:59:59') < corte).toBe(true);
    expect(br('2026-10-26T00:00:01') < corte).toBe(false);
  });

  it('virada de mês e de ano', () => {
    expect(diaEmBrasilia(dataDePagamento(br('2026-12-31T12:00:00')))).toBe('2027-01-06');
  });
});
