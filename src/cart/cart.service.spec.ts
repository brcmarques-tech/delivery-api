import { CartService } from './cart.service';

/**
 * Adicionar de novo um produto que ja esta no carrinho.
 *
 * O app manda `weightGrams: null` e `notes: null` para produto por unidade. O
 * servico testava `!== undefined`, e `null` passa nesse teste: entrava no ramo
 * do PESO, gravava peso nulo e pulava a soma. O "+" do card nunca aumentava a
 * quantidade, e a observacao que a pessoa tinha escrito era apagada.
 */
describe('CartService.addToCart — item que ja esta no carrinho', () => {
  const existente = { id: 'item-1', quantity: 1, notes: 'sem cebola' };

  function montar() {
    const cartItemRepo = {
      findOne: jest.fn().mockResolvedValue(existente),
      update: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
      findOneOrFail: jest.fn().mockResolvedValue(existente),
    };
    const productRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'p1', isAvailable: true, isActive: true, store: { id: 's1' },
      }),
    };
    const service = new CartService(cartItemRepo as any, productRepo as any);
    return { service, cartItemRepo };
  }

  it('com weightGrams e notes null (como o app manda), SOMA a quantidade', async () => {
    const { service, cartItemRepo } = montar();
    await service.addToCart(
      { productId: 'p1', quantity: 1, weightGrams: null, notes: null } as any,
      'cliente-1',
    );
    expect(cartItemRepo.increment).toHaveBeenCalledWith({ id: 'item-1' }, 'quantity', 1);
  });

  it('com notes null, NAO apaga a observacao que ja existia', async () => {
    const { service, cartItemRepo } = montar();
    await service.addToCart(
      { productId: 'p1', quantity: 1, weightGrams: null, notes: null } as any,
      'cliente-1',
    );
    const gravouNotas = cartItemRepo.update.mock.calls.some(([, campos]) => 'notes' in campos);
    expect(gravouNotas).toBe(false);
  });

  it('com peso informado, atualiza o peso e nao soma unidade', async () => {
    const { service, cartItemRepo } = montar();
    await service.addToCart({ productId: 'p1', quantity: 1, weightGrams: 750 } as any, 'cliente-1');
    expect(cartItemRepo.update).toHaveBeenCalledWith('item-1', { weightGrams: 750 });
    expect(cartItemRepo.increment).not.toHaveBeenCalled();
  });

  it('com observacao nova, grava a observacao', async () => {
    const { service, cartItemRepo } = montar();
    await service.addToCart({ productId: 'p1', quantity: 1, notes: 'bem passado' } as any, 'cliente-1');
    expect(cartItemRepo.update).toHaveBeenCalledWith('item-1', { notes: 'bem passado' });
  });
});
