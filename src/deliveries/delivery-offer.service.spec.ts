import { DeliveryOfferService } from './delivery-offer.service';

/**
 * Vez exclusiva da cascata de ofertas.
 *
 * Antes a vez existia só no servidor: a lista "Disponíveis" mostrava toda
 * corrida a todo entregador e o aceite não olhava de quem era a vez.
 */
describe('DeliveryOfferService — vez exclusiva', () => {
  // Três entregadores online; "perto" é o mais próximo da loja.
  const online = [
    { userId: 'perto', socketId: 's-perto', distance: 0.5 },
    { userId: 'medio', socketId: 's-medio', distance: 2 },
    { userId: 'longe', socketId: 's-longe', distance: 5 },
  ];

  function montar(filtro?: (id: string) => Promise<boolean>) {
    const tracker = {
      getNearestDeliverers: jest.fn((_lat: number, _lng: number, excluir: Set<string>) =>
        online.filter((d) => !excluir.has(d.userId)),
      ),
    };
    const notificacoes = { sendToUser: jest.fn().mockResolvedValue(undefined), sendToUsers: jest.fn() };
    const whatsapp = { notifyNewDeliveryAvailable: jest.fn().mockResolvedValue(undefined) };
    const usuarios = { findById: jest.fn().mockResolvedValue(null), findAllDeliverers: jest.fn().mockResolvedValue([]) };
    const service = new DeliveryOfferService(tracker as any, notificacoes as any, whatsapp as any, usuarios as any);
    const enviados: Array<{ socket: string; evento: string }> = [];
    service.setEmitters((socket, evento) => enviados.push({ socket, evento }), () => {});
    if (filtro) service.definirFiltroDeCandidato(filtro);
    return { service, enviados };
  }

  const pedido = {
    id: 'pedido-1', customerId: 'cliente', orderNumber: 'ORD-1', storeLat: 0, storeLng: 0,
    storeAddress: 'Loja', deliveryAddress: 'Casa', deliveryFee: 5, itemCount: 1,
  };

  // a cascata e assincrona (o filtro consulta o banco): deixa a fila de
  // promessas andar antes de conferir
  const andar = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('oferece ao mais perto, e só ele vê a corrida, com o tempo da vez', async () => {
    const { service } = montar();
    service.startOffer(pedido);
    await andar();
    expect(service.estadoPara('pedido-1', 'perto')).toEqual({ visivel: true, segundosRestantes: 60 });
    expect(service.estadoPara('pedido-1', 'medio').visivel).toBe(false);
    expect(service.estadoPara('pedido-1', 'longe').visivel).toBe(false);
  });

  it('ninguém fora da vez pode aceitar', async () => {
    const { service } = montar();
    service.startOffer(pedido);
    await andar();
    expect(service.reservadaParaOutro('pedido-1', 'medio')).toBe(true);
    expect(service.reservadaParaOutro('pedido-1', 'perto')).toBe(false);
  });

  it('recusar passa a vez na hora para o próximo, e avisa quem recusou', async () => {
    const { service, enviados } = montar();
    service.startOffer(pedido);
    await andar();
    expect(service.declineOffer('pedido-1', 'perto')).toBe(true);
    await andar();
    expect(service.estadoPara('pedido-1', 'perto').visivel).toBe(false);
    expect(service.estadoPara('pedido-1', 'medio').visivel).toBe(true);
    expect(enviados).toContainEqual({ socket: 's-perto', evento: 'ofertaEncerrada' });
  });

  it('recusar fora da vez não faz nada', async () => {
    const { service } = montar();
    service.startOffer(pedido);
    await andar();
    expect(service.declineOffer('pedido-1', 'longe')).toBe(false);
    expect(service.estadoPara('pedido-1', 'perto').visivel).toBe(true);
  });

  it('acabou o tempo da vez: vai para o próximo', async () => {
    const { service } = montar();
    service.startOffer(pedido);
    await andar();
    jest.advanceTimersByTime(60_000);
    await andar();
    expect(service.estadoPara('pedido-1', 'perto').visivel).toBe(false);
    expect(service.estadoPara('pedido-1', 'medio').visivel).toBe(true);
  });

  it('pula quem não pode pegar a corrida agora (já em outra entrega)', async () => {
    const { service } = montar(async (id) => id !== 'perto');
    service.startOffer(pedido);
    await andar();
    expect(service.estadoPara('pedido-1', 'perto').visivel).toBe(false);
    expect(service.estadoPara('pedido-1', 'medio').visivel).toBe(true);
  });

  it('depois dos 10 minutos a corrida abre para todos', async () => {
    const { service } = montar();
    service.startOffer(pedido);
    await andar();
    for (let i = 0; i < 20; i++) {
      jest.advanceTimersByTime(60_000);
      await andar();
    }
    expect(service.estadoPara('pedido-1', 'longe')).toEqual({ visivel: true, segundosRestantes: null });
    expect(service.reservadaParaOutro('pedido-1', 'longe')).toBe(false);
  });

  it('corrida fora da cascata está aberta para qualquer entregador', () => {
    const { service } = montar();
    expect(service.estadoPara('outro-pedido', 'qualquer')).toEqual({ visivel: true, segundosRestantes: null });
  });
});
