import { CouponsService } from './coupons.service';

// Cupom multi-uso (BUGFIX): a reserva de uso passou a acontecer na CRIACAO do
// pedido (para todos os metodos), via incrementUsage atomico-condicional. Antes,
// pagamento online so incrementava no webhook — na janela entre criar e pagar,
// varios clientes usavam o mesmo cupom de uso unico. Estes testes travam o
// mecanismo central: incrementUsage so reserva enquanto ha slot.

describe('CouponsService.incrementUsage (cupom multi-uso)', () => {
  let service: CouponsService;
  let queryMock: jest.Mock;

  beforeEach(() => {
    queryMock = jest.fn();
    const couponsRepo: any = { manager: { query: queryMock } };
    service = new CouponsService(couponsRepo, {} as any, {} as any);
  });

  it('reserva quando ha slot (UPDATE afeta linha) -> true', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'c1' }]); // RETURNING id devolveu 1 linha
    const ok = await service.incrementUsage('c1');
    expect(ok).toBe(true);
    // guard atomico-condicional presente na query
    expect(queryMock.mock.calls[0][0]).toMatch(/usesCount.*<.*maxUses/s);
    expect(queryMock.mock.calls[0][0]).toMatch(/RETURNING id/);
  });

  it('cupom esgotado (UPDATE nao afeta linha) -> false', async () => {
    queryMock.mockResolvedValueOnce([]); // nenhuma linha: usesCount ja == maxUses
    const ok = await service.incrementUsage('c1');
    expect(ok).toBe(false);
  });

  it('usa o EntityManager transacional quando passado (participa do rollback do pedido)', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce([{ id: 'c1' }]);
    const manager: any = { query: txQuery };
    const ok = await service.incrementUsage('c1', manager);
    expect(ok).toBe(true);
    expect(txQuery).toHaveBeenCalledTimes(1); // rodou no manager da transacao
    expect(queryMock).not.toHaveBeenCalled(); // nao no manager global
  });
});
