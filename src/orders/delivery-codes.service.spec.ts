import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeliveryCodesService } from './delivery-codes.service';
import { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

/**
 * ENTREGA SEM O CÓDIGO DO CLIENTE — a janela de contestação.
 *
 * Este é o caminho que libera dinheiro SEM o segredo que autoriza o pagamento.
 * O que o torna legítimo é uma promessa escrita no próprio código: "abre uma
 * janela de contestação para o cliente". O E2E
 * `scripts/provas/e2e-entrega-sem-codigo.mjs` mediu essa promessa e encontrou as
 * duas metades dela quebradas — o cliente não era avisado, e no estado em que o
 * pedido ficava ele não conseguia contestar nem se soubesse.
 *
 * O E2E prova a parte observável (o pedido vai para um estado contestável e o
 * scheduler respeita a disputa). Estes testes cobrem o que o E2E não alcança na
 * stack local, porque nem Expo nem WAHA sobem aqui: o CONTEÚDO do aviso. Um
 * aviso sem prazo não é oportunidade de contestar — é comunicado de que algo
 * aconteceu.
 */
describe('DeliveryCodesService — entrega sem código', () => {
  let service: DeliveryCodesService;
  let ordersService: any;
  let deliveriesService: any;
  let notifications: any;
  let whatsApp: any;
  let repo: any;

  const PEDIDO_BASE = {
    id: 'order-1',
    orderNumber: '4242',
    codigoVendedor: '111111',
    codigoVendedorUsadoEm: new Date(),
    codigoEntregadorUsadoEm: new Date(),
    codigoClienteUsadoEm: null,
    customer: { id: 'cli-1', phone: '5351999990000' },
    delivery: { id: 'ent-1', deliverer: { id: 'entregador-1' } },
  };

  // O driver do Postgres devolve [linhas, quantidade] em UPDATE com RETURNING.
  const claimGanho = [[{ id: 'order-1' }], 1];
  const claimPerdido = [[], 0];

  function montar(pedido: any = PEDIDO_BASE) {
    ordersService = { findById: jest.fn().mockResolvedValue(pedido) };
    deliveriesService = { confirmDelivery: jest.fn().mockResolvedValue({}) };
    notifications = { sendToAppUser: jest.fn().mockResolvedValue(undefined) };
    whatsApp = { sendText: jest.fn().mockResolvedValue(true) };
    repo = { manager: { query: jest.fn().mockResolvedValue(claimGanho) } };
  }

  async function instanciar(): Promise<void> {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryCodesService,
        { provide: getRepositoryToken(Order), useValue: repo },
        { provide: OrdersService, useValue: ordersService },
        { provide: DeliveriesService, useValue: deliveriesService },
        { provide: NotificationsService, useValue: notifications },
        { provide: WhatsAppService, useValue: whatsApp },
      ],
    }).compile();
    service = mod.get<DeliveryCodesService>(DeliveryCodesService);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  }

  const registrar = (over: any = {}) =>
    service.registrarEntregaSemCodigo({
      orderId: 'order-1',
      delivererId: 'entregador-1',
      motivo: 'cliente nao atendeu a campainha nem o telefone',
      latitude: -31.76,
      longitude: -52.33,
      ...over,
    });

  beforeEach(async () => {
    delete process.env.DELIVERY_NO_CODE_DISPUTE_HOURS;
    montar();
    await instanciar();
  });

  // ─── o aviso ao cliente ────────────────────────────────────────────────

  it('avisa o cliente pelos DOIS canais (push e WhatsApp)', async () => {
    await registrar();
    expect(notifications.sendToAppUser).toHaveBeenCalledTimes(1);
    expect(whatsApp.sendText).toHaveBeenCalledTimes(1);
    expect(notifications.sendToAppUser.mock.calls[0][0]).toBe('cli-1');
    expect(whatsApp.sendText.mock.calls[0][0]).toBe('5351999990000');
  });

  it('o aviso diz o PRAZO — sem prazo não é oportunidade de contestar', async () => {
    await registrar();
    const corpo = notifications.sendToAppUser.mock.calls[0][2];
    expect(corpo).toContain('24h');
    expect(whatsApp.sendText.mock.calls[0][1]).toContain('24h');
  });

  it('o prazo do aviso acompanha DELIVERY_NO_CODE_DISPUTE_HOURS', async () => {
    // Se a janela for reconfigurada e o aviso continuar dizendo 24h, o cliente
    // perde o direito acreditando que ainda tem tempo.
    process.env.DELIVERY_NO_CODE_DISPUTE_HOURS = '6';
    await registrar();
    expect(notifications.sendToAppUser.mock.calls[0][2]).toContain('6h');
  });

  it('o aviso identifica o pedido e repete o motivo alegado', async () => {
    await registrar({ motivo: 'deixei com o porteiro do predio ao lado' });
    const corpo = notifications.sendToAppUser.mock.calls[0][2];
    expect(corpo).toContain('#4242');
    expect(corpo).toContain('deixei com o porteiro do predio ao lado');
  });

  it('carrega o tipo e o pedido no payload do push (o app precisa abrir a tela)', async () => {
    await registrar();
    expect(notifications.sendToAppUser.mock.calls[0][3]).toEqual(
      expect.objectContaining({ type: 'DELIVERY_WITHOUT_CODE', orderId: 'order-1' }),
    );
  });

  it('falha de notificação NÃO derruba o registro da entrega', async () => {
    // O entregador já está na porta e o registro dele é o que sustenta o
    // pagamento. Expo fora do ar não pode custar a entrega dele.
    notifications.sendToAppUser.mockRejectedValue(new Error('expo fora do ar'));
    whatsApp.sendText.mockRejectedValue(new Error('waha fora do ar'));
    await expect(registrar()).resolves.toBeDefined();
  });

  it('sem telefone, manda só o push (não inventa destinatário)', async () => {
    montar({ ...PEDIDO_BASE, customer: { id: 'cli-1', phone: null } });
    await instanciar();
    await registrar();
    expect(notifications.sendToAppUser).toHaveBeenCalledTimes(1);
    expect(whatsApp.sendText).not.toHaveBeenCalled();
  });

  // ─── o estado que torna a contestação possível ─────────────────────────

  it('move o pedido para um estado contestável, via confirmDelivery', async () => {
    // A máquina de estados não permite DELIVERING -> DISPUTED. Sem este passo o
    // cliente recebe "Este pedido nao esta aguardando confirmacao de entrega" ao
    // tentar contestar, e a janela inteira fica decorativa.
    await registrar();
    expect(deliveriesService.confirmDelivery).toHaveBeenCalledWith('ent-1', 'entregador-1', true);
  });

  it('o terceiro argumento de confirmDelivery é true (pedido com código)', async () => {
    // `confirmDelivery` recusa pedido com código quando `viaCodigo` é false —
    // é a guarda que impede o botão antigo de contornar os códigos.
    await registrar();
    expect(deliveriesService.confirmDelivery.mock.calls[0][2]).toBe(true);
  });

  it('não libera dinheiro no registro — quem libera é o scheduler da janela', async () => {
    const chamadas = Object.keys(ordersService);
    expect(chamadas).not.toContain('completeOrderWithPayment');
    await registrar();
    // só a releitura final; nenhuma finalização
    expect(ordersService.findById).toHaveBeenCalled();
  });

  // ─── as guardas ────────────────────────────────────────────────────────

  it('recusa motivo com menos de 10 caracteres', async () => {
    await expect(registrar({ motivo: 'nao abriu' })).rejects.toThrow(BadRequestException);
    expect(deliveriesService.confirmDelivery).not.toHaveBeenCalled();
    expect(notifications.sendToAppUser).not.toHaveBeenCalled();
  });

  it('recusa quem não é o entregador da entrega', async () => {
    await expect(registrar({ delivererId: 'outro-entregador' })).rejects.toThrow(ForbiddenException);
  });

  it('exige a coleta confirmada pelos dois códigos', async () => {
    montar({ ...PEDIDO_BASE, codigoEntregadorUsadoEm: null });
    await instanciar();
    await expect(registrar()).rejects.toThrow(/Confirme a coleta/);
  });

  it('recusa pedido que não usa confirmação por código', async () => {
    montar({ ...PEDIDO_BASE, codigoVendedor: null });
    await instanciar();
    await expect(registrar()).rejects.toThrow(/não usa confirmação por código/);
  });

  it('recusa quando a entrega já foi confirmada pelo código do cliente', async () => {
    montar({ ...PEDIDO_BASE, codigoClienteUsadoEm: new Date() });
    await instanciar();
    await expect(registrar()).rejects.toThrow(/já foi confirmada por código/);
  });

  it('perder o claim atômico não avisa nem avança o pedido', async () => {
    // Dois toques no botão: um só registro. E o segundo não pode disparar um
    // segundo aviso ao cliente nem uma segunda transição de estado.
    repo.manager.query.mockResolvedValue(claimPerdido);
    await expect(registrar()).rejects.toThrow(/já foi registrada sem código/);
    expect(deliveriesService.confirmDelivery).not.toHaveBeenCalled();
    expect(notifications.sendToAppUser).not.toHaveBeenCalled();
    expect(whatsApp.sendText).not.toHaveBeenCalled();
  });
});
