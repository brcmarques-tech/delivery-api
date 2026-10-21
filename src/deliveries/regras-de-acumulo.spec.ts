import { motivoParaNaoSomar } from './regras-de-acumulo';

describe('motivoParaNaoSomar — várias entregas da mesma loja', () => {
  it('sem nenhuma em andamento, pode', () => {
    expect(motivoParaNaoSomar([], 'loja-1')).toBeNull();
  });

  it('com uma da mesma loja, esperando coleta, pode somar', () => {
    expect(motivoParaNaoSomar([{ storeId: 'loja-1', status: 'READY' }], 'loja-1')).toBeNull();
  });

  it('com duas da mesma loja esperando coleta, pode somar a terceira', () => {
    const tem = [
      { storeId: 'loja-1', status: 'READY' },
      { storeId: 'loja-1', status: 'READY' },
    ];
    expect(motivoParaNaoSomar(tem, 'loja-1')).toBeNull();
  });

  it('com uma de OUTRA loja, não pode', () => {
    expect(motivoParaNaoSomar([{ storeId: 'loja-2', status: 'READY' }], 'loja-1')).toMatch(/outra loja/);
  });

  it('se já saiu da loja com uma (coletou), não pode somar outra da mesma loja', () => {
    expect(motivoParaNaoSomar([{ storeId: 'loja-1', status: 'DELIVERING' }], 'loja-1')).toMatch(/saiu da loja/);
  });

  it('loja confirmou a retirada de uma delas: também já saiu', () => {
    const tem = [
      { storeId: 'loja-1', status: 'READY' },
      { storeId: 'loja-1', status: 'VENDOR_CONFIRMED_PICKUP' },
    ];
    expect(motivoParaNaoSomar(tem, 'loja-1')).toMatch(/saiu da loja/);
  });
});
