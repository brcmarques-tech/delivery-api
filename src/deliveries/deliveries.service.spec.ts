import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';
import { Delivery } from './entities/delivery.entity';
import { OrdersService } from '../orders/orders.service';
import { DeliveryOfferService } from './delivery-offer.service';
import { OrderStatus } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../config/platform-config.service';

describe('DeliveriesService', () => {
  let service: DeliveriesService;
  let deliveriesRepo: any;
  let ordersService: any;
  let pubSub: any;

  // KAN-254: `acceptDelivery` passou a rodar numa transacao com lock de linha
  // (`SELECT ... FOR UPDATE`) para impedir que dois entregadores aceitem a
  // mesma entrega. O mock nao tinha `manager`, entao o teste morria em
  // "Cannot read properties of undefined (reading 'transaction')" — mock
  // desatualizado, nao bug de codigo.
  //
  // `transaction(cb)` so executa o callback com um manager fake; `query`
  // responde conforme o SQL: SELECT do pedido devolve uma linha, SELECT de
  // delivery existente devolve vazio (caminho "primeira aceitacao") e o INSERT
  // devolve o id gerado.
  const mockTxManager = {
    query: jest.fn(async (sql: string) => {
      if (/FROM orders/i.test(sql)) return [{ id: 'order-1', status: 'READY' }];
      if (/FROM deliveries/i.test(sql)) return [];
      if (/INSERT INTO deliveries/i.test(sql)) return [{ id: 'delivery-1' }];
      return [];
    }),
  };

  const mockDeliveriesRepo = {
    create: jest.fn((data) => ({ id: 'delivery-1', ...data })),
    save: jest.fn((data) => Promise.resolve({ id: 'delivery-1', ...data })),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: {
      transaction: jest.fn(async (cb: any) => cb(mockTxManager)),
      query: jest.fn().mockResolvedValue([]),
    },
  };

  const mockOrdersService = {
    findById: jest.fn(),
    updateStatus: jest.fn(),
    onOrderReady: jest.fn(),
  };

  const mockOfferService = {
    startOffer: jest.fn(),
    // KAN-254: `acceptDelivery` cancela a cascata de ofertas ao aceitar.
    // O metodo nao existia no mock e derrubava o teste.
    cancelOffer: jest.fn(),
  };

  const mockPubSub = {
    publish: jest.fn(),
  };

  const mockNotificationsService = {
    sendToVendorUser: jest.fn().mockResolvedValue(undefined),
    sendToAppUser: jest.fn().mockResolvedValue(undefined),
  };

// Comissao de entrega padrao da plataforma (10%): payoutAmount e o LIQUIDO que
// o entregador recebe, nao a taxa cheia.
const mockPlatformConfig = {
  getDeliveryCommissionPercent: jest.fn().mockResolvedValue(10),
};

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveriesService,
        { provide: getRepositoryToken(Delivery), useValue: mockDeliveriesRepo },
        { provide: OrdersService, useValue: mockOrdersService },
        { provide: DeliveryOfferService, useValue: mockOfferService },
        { provide: PUB_SUB, useValue: mockPubSub },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: PlatformConfigService, useValue: mockPlatformConfig },
      ],
    }).compile();

    service = module.get<DeliveriesService>(DeliveriesService);
    deliveriesRepo = mockDeliveriesRepo;
    ordersService = mockOrdersService;
    pubSub = mockPubSub;
  });

  // ─── Helper factories ───────────────────────────────────────
  function makeDeliverer(overrides: any = {}) {
    return {
      id: 'deliverer-1',
      name: 'Pedro Entregador',
      paymentConnected: true,
      pagarmeRecipientId: 'rp_deliverer_1',
      ...overrides,
    };
  }

  function makeOrder(overrides: any = {}) {
    return {
      id: 'order-1',
      orderNumber: '1001',
      status: OrderStatus.READY,
      subtotal: 50.0,
      deliveryFee: 5.0,
      total: 55.0,
      commissionAmount: 2.5,
      paymentMethod: 'MERCADO_PAGO',
      store: {
        id: 'store-1',
        hasOwnDelivery: false,
        owner: { id: 'vendor-1', pagarmeRecipientId: 'rp_vendor_1' },
      },
      items: [{ product: { name: 'Pizza' } }],
      ...overrides,
    };
  }

  function makeDelivery(overrides: any = {}) {
    return {
      id: 'delivery-1',
      order: makeOrder(),
      deliverer: makeDeliverer(),
      deliveredAt: null,
      pickedUpAt: null,
      payoutStatus: null,
      payoutAmount: null,
      vendorPayoutStatus: null,
      vendorPayoutAmount: null,
      ...overrides,
    };
  }

  // ─── acceptDelivery ─────────────────────────────────────────
  describe('acceptDelivery', () => {
    it('should throw if deliverer has no payment connected', async () => {
      const deliverer = makeDeliverer({ paymentConnected: false });
      await expect(
        service.acceptDelivery('order-1', deliverer as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create delivery, update order status, and publish', async () => {
      const deliverer = makeDeliverer();
      const order = makeOrder();
      ordersService.findById.mockResolvedValue(order);
      // KAN-254: a criacao deixou de ser `repo.create()/save()` e passou a ser
      // um INSERT em SQL puro DENTRO de uma transacao com `SELECT ... FOR
      // UPDATE` — necessario para impedir que dois entregadores aceitem a mesma
      // entrega. Depois o service recarrega o registro com `findOneOrFail`.
      // O teste ainda checava `create`, que nao e mais chamado.
      deliveriesRepo.findOneOrFail.mockResolvedValue({ id: 'delivery-1', order, deliverer });
      // findOne é usado em dois momentos: (1) o pré-check de "entrega ativa" (deve
      // dar null) e (2) o reload por id do publishDeliveryUpdate, que recarrega o
      // delivery completo para o payload da subscription. Ramifica pelo `where`.
      deliveriesRepo.findOne.mockImplementation((opts: any) =>
        opts?.where?.id === 'delivery-1'
          ? Promise.resolve({ id: 'delivery-1', order, deliverer })
          : Promise.resolve(null),
      );

      const result = await service.acceptDelivery('order-1', deliverer as any);

      // A transacao rodou (lock + insert)
      expect(deliveriesRepo.manager.transaction).toHaveBeenCalled();
      expect(deliveriesRepo.findOneOrFail).toHaveBeenCalled();
      expect(result).toBeDefined();
      // KAN-254: aceitar a entrega NAO muda mais o status do pedido. Aceitar
      // (entregador) e confirmar a coleta (vendedor) viraram passos distintos —
      // VENDOR_CONFIRMED_PICKUP acontece em outro fluxo. O que acontece aqui e:
      // encerrar a cascata de ofertas e publicar as atualizacoes.
      expect(mockOfferService.cancelOffer).toHaveBeenCalledWith('order-1');
      expect(pubSub.publish).toHaveBeenCalledWith('deliveryUpdated', expect.any(Object));
      expect(pubSub.publish).toHaveBeenCalledWith('orderUpdated', expect.any(Object));
    });
  });

  // ─── updateLocation ─────────────────────────────────────────
  describe('updateLocation', () => {
    it('should update lat/lng and publish', async () => {
      const delivery = makeDelivery();
      deliveriesRepo.findOne.mockResolvedValue(delivery);
      deliveriesRepo.save.mockResolvedValue({ ...delivery, currentLatitude: -31.5, currentLongitude: -52.3 });

      await service.updateLocation('delivery-1', -31.5, -52.3);

      expect(delivery.currentLatitude).toBe(-31.5);
      expect(delivery.currentLongitude).toBe(-52.3);
      expect(pubSub.publish).toHaveBeenCalled();
    });

    it('should throw if delivery not found', async () => {
      deliveriesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateLocation('bad-id', 0, 0),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── confirmPickup ──────────────────────────────────────────
  describe('confirmPickup', () => {
    it('should set pickedUpAt and update order status to PICKED_UP', async () => {
      const delivery = makeDelivery();
      deliveriesRepo.findOne.mockResolvedValue(delivery);
      deliveriesRepo.save.mockResolvedValue(delivery);

      const result = await service.confirmPickup('delivery-1', 'deliverer-1');

      expect(delivery.pickedUpAt).toBeInstanceOf(Date);
      // KAN-254: o fluxo ganhou um passo — a coleta agora marca PICKED_UP, e
      // DELIVERING passou a ser um estado posterior. O teste ainda esperava o
      // comportamento antigo (ia direto para DELIVERING).
      expect(ordersService.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.PICKED_UP);
      expect(pubSub.publish).toHaveBeenCalled();
    });

    it('should throw if delivery not found', async () => {
      deliveriesRepo.findOne.mockResolvedValue(null);
      await expect(service.confirmPickup('bad-id', 'deliverer-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── confirmDelivery ────────────────────────────────────────
  describe('confirmDelivery', () => {
    it('should set deliveredAt and update order status to DELIVERED', async () => {
      const delivery = makeDelivery();
      deliveriesRepo.findOne.mockResolvedValue(delivery);
      deliveriesRepo.save.mockResolvedValue(delivery);

      await service.confirmDelivery('delivery-1', 'deliverer-1');

      expect(delivery.deliveredAt).toBeInstanceOf(Date);
      expect(ordersService.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.DELIVERER_CONFIRMED_DELIVERY);
    });

    it('should throw if delivery not found', async () => {
      deliveriesRepo.findOne.mockResolvedValue(null);
      await expect(service.confirmDelivery('bad-id', 'deliverer-1')).rejects.toThrow(NotFoundException);
    });

    describe('payment tracking (Pagar.me split_auto)', () => {
      it('should set vendor payout as split_auto', async () => {
        const delivery = makeDelivery();
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1', 'deliverer-1');

        // vendorAmount = subtotal (50) - commission (2.5) = 47.5
        expect(delivery.vendorPayoutAmount).toBe(47.5);
        expect(delivery.vendorPayoutStatus).toBe('paid_on_pickup');
      });

      it('should set deliverer payout as split_auto when platform handles delivery', async () => {
        const delivery = makeDelivery();
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1', 'deliverer-1');

        // 5.00 de taxa - 10% de comissao = 4.50 liquido. Antes o teste exigia
        // 5.00, congelando o bug: o app prometia a taxa cheia e o extrato do
        // Pagar.me mostrava o liquido.
        expect(delivery.payoutAmount).toBe(4.5);
        expect(delivery.payoutStatus).toBe('pending_confirmation');
      });

      it('should NOT set deliverer payout when store has own delivery', async () => {
        const delivery = makeDelivery({
          order: makeOrder({
            store: { id: 'store-1', hasOwnDelivery: true, owner: { id: 'v1' } },
          }),
        });
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1', 'deliverer-1');

        expect(delivery.payoutAmount).toBeNull();
        expect(delivery.payoutStatus).toBeNull();
      });
    });

    describe('payment tracking for PIX', () => {
      it('should set vendor payout as split_auto for PIX', async () => {
        const delivery = makeDelivery({
          order: makeOrder({ paymentMethod: 'PIX' }),
        });
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1', 'deliverer-1');

        expect(delivery.vendorPayoutStatus).toBe('paid_on_pickup');
        expect(delivery.vendorPayoutAmount).toBe(47.5);
      });

      it('should set deliverer payout as split_auto for PIX', async () => {
        const delivery = makeDelivery({
          order: makeOrder({ paymentMethod: 'PIX' }),
        });
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1', 'deliverer-1');

        // 5.00 de taxa - 10% de comissao = 4.50 liquido. Antes o teste exigia
        // 5.00, congelando o bug: o app prometia a taxa cheia e o extrato do
        // Pagar.me mostrava o liquido.
        expect(delivery.payoutAmount).toBe(4.5);
        expect(delivery.payoutStatus).toBe('pending_confirmation');
      });
    });

    describe('payment tracking for ON_DELIVERY', () => {
      it('should NOT set any payout for cash payments', async () => {
        const delivery = makeDelivery({
          order: makeOrder({ paymentMethod: 'ON_DELIVERY' }),
        });
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1', 'deliverer-1');

        expect(delivery.vendorPayoutStatus).toBeNull();
        expect(delivery.vendorPayoutAmount).toBeNull();
        expect(delivery.payoutStatus).toBeNull();
        expect(delivery.payoutAmount).toBeNull();
      });
    });

    it('should publish deliveryUpdated event', async () => {
      const delivery = makeDelivery();
      deliveriesRepo.findOne.mockResolvedValue(delivery);
      deliveriesRepo.save.mockResolvedValue(delivery);

      await service.confirmDelivery('delivery-1', 'deliverer-1');

      expect(pubSub.publish).toHaveBeenCalledWith('deliveryUpdated', expect.any(Object));
    });
  });

  // ─── findExpiredPendingConfirmations ────────────────────────
  describe('findExpiredPendingConfirmations', () => {
    it('should query deliveries delivered more than 10 min ago with no customer confirmation', async () => {
      const mockQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      deliveriesRepo.createQueryBuilder.mockReturnValue(mockQb);

      await service.findExpiredPendingConfirmations();

      expect(mockQb.where).toHaveBeenCalledWith('delivery.deliveredAt IS NOT NULL');
      expect(mockQb.andWhere).toHaveBeenCalledWith('order.customerConfirmedAt IS NULL');
    });
  });

  // ─── findByDeliverer ────────────────────────────────────────
  describe('findByDeliverer', () => {
    it('should query deliveries for given deliverer (primeira pagina)', async () => {
      deliveriesRepo.find.mockResolvedValue([]);
      await service.findByDeliverer('d1');
      expect(deliveriesRepo.find).toHaveBeenCalledWith({
        where: { deliverer: { id: 'd1' } },
        // KAN-254: a query passou a carregar tambem os itens do pedido e o
        // produto de cada item (a tela do entregador precisa listar o que
        // separar). O teste ainda esperava a lista antiga de relations.
        relations: ['order', 'order.store', 'order.customer', 'order.items', 'order.items.product'],
        order: { createdAt: 'DESC' },
        // Perf (F6): a lista passou a ser paginada — antes descia o historico
        // vitalicio inteiro a cada abertura da aba Entregas.
        take: 20,
        skip: 0,
      });
    });

    it('should respect limit/offset and cap the page size at 100', async () => {
      deliveriesRepo.find.mockResolvedValue([]);
      await service.findByDeliverer('d1', 50, 40);
      expect(deliveriesRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, skip: 40 }),
      );

      deliveriesRepo.find.mockClear();
      await service.findByDeliverer('d1', 9999, -5);
      expect(deliveriesRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100, skip: 0 }),
      );
    });
  });

  // ─── count methods ──────────────────────────────────────────
  describe('count methods', () => {
    it('totalCount should count all deliveries', async () => {
      deliveriesRepo.count.mockResolvedValue(42);
      expect(await service.totalCount()).toBe(42);
    });

    it('completedCount should count delivered', async () => {
      deliveriesRepo.count.mockResolvedValue(30);
      const result = await service.completedCount();
      expect(result).toBe(30);
    });

    it('activeCount should count not delivered', async () => {
      deliveriesRepo.count.mockResolvedValue(12);
      const result = await service.activeCount();
      expect(result).toBe(12);
    });
  });
});
