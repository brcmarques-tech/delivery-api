import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';
import { Delivery } from './entities/delivery.entity';
import { OrdersService } from '../orders/orders.service';
import { DeliveryOfferService } from './delivery-offer.service';
import { PaymentsService } from '../payments/payments.service';
import { OrderStatus } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

describe('DeliveriesService', () => {
  let service: DeliveriesService;
  let deliveriesRepo: any;
  let ordersService: any;
  let paymentsService: any;
  let pubSub: any;

  const mockDeliveriesRepo = {
    create: jest.fn((data) => ({ id: 'delivery-1', ...data })),
    save: jest.fn((data) => Promise.resolve({ id: 'delivery-1', ...data })),
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockOrdersService = {
    findById: jest.fn(),
    updateStatus: jest.fn(),
    onOrderReady: jest.fn(),
  };

  const mockOfferService = {
    startOffer: jest.fn(),
  };

  const mockPaymentsService = {
    transferToDeliverer: jest.fn(),
    transferToVendor: jest.fn(),
  };

  const mockPubSub = {
    publish: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveriesService,
        { provide: getRepositoryToken(Delivery), useValue: mockDeliveriesRepo },
        { provide: OrdersService, useValue: mockOrdersService },
        { provide: DeliveryOfferService, useValue: mockOfferService },
        { provide: PaymentsService, useValue: mockPaymentsService },
        { provide: PUB_SUB, useValue: mockPubSub },
      ],
    }).compile();

    service = module.get<DeliveriesService>(DeliveriesService);
    deliveriesRepo = mockDeliveriesRepo;
    ordersService = mockOrdersService;
    paymentsService = mockPaymentsService;
    pubSub = mockPubSub;
  });

  // ─── Helper factories ───────────────────────────────────────
  function makeDeliverer(overrides: any = {}) {
    return {
      id: 'deliverer-1',
      name: 'Pedro Entregador',
      mpConnected: true,
      mpUserId: '12345',
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
        owner: { id: 'vendor-1', mpAccessToken: 'token' },
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
    it('should throw if deliverer has no MP connected', async () => {
      const deliverer = makeDeliverer({ mpConnected: false });
      await expect(
        service.acceptDelivery('order-1', deliverer as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create delivery, update order status, and publish', async () => {
      const deliverer = makeDeliverer();
      const order = makeOrder();
      ordersService.findById.mockResolvedValue(order);
      deliveriesRepo.save.mockResolvedValue({ id: 'del-1', order, deliverer });

      const result = await service.acceptDelivery('order-1', deliverer as any);

      expect(deliveriesRepo.create).toHaveBeenCalledWith({ order, deliverer });
      expect(ordersService.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.PICKED_UP);
      expect(pubSub.publish).toHaveBeenCalledWith('deliveryUpdated', expect.any(Object));
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
    it('should set pickedUpAt and update order status to DELIVERING', async () => {
      const delivery = makeDelivery();
      deliveriesRepo.findOne.mockResolvedValue(delivery);
      deliveriesRepo.save.mockResolvedValue(delivery);

      const result = await service.confirmPickup('delivery-1');

      expect(delivery.pickedUpAt).toBeInstanceOf(Date);
      expect(ordersService.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.DELIVERING);
      expect(pubSub.publish).toHaveBeenCalled();
    });

    it('should throw if delivery not found', async () => {
      deliveriesRepo.findOne.mockResolvedValue(null);
      await expect(service.confirmPickup('bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── confirmDelivery ────────────────────────────────────────
  describe('confirmDelivery', () => {
    it('should set deliveredAt and update order status to DELIVERED', async () => {
      const delivery = makeDelivery();
      deliveriesRepo.findOne.mockResolvedValue(delivery);
      deliveriesRepo.save.mockResolvedValue(delivery);

      await service.confirmDelivery('delivery-1');

      expect(delivery.deliveredAt).toBeInstanceOf(Date);
      expect(ordersService.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.DELIVERED);
    });

    it('should throw if delivery not found', async () => {
      deliveriesRepo.findOne.mockResolvedValue(null);
      await expect(service.confirmDelivery('bad-id')).rejects.toThrow(NotFoundException);
    });

    describe('payment distribution for MERCADO_PAGO', () => {
      it('should set vendor payout as split_auto', async () => {
        const delivery = makeDelivery();
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1');

        // vendorAmount = subtotal (50) - commission (2.5) = 47.5
        expect(delivery.vendorPayoutAmount).toBe(47.5);
        expect(delivery.vendorPayoutStatus).toBe('split_auto');
      });

      it('should set deliverer payout as pending_confirmation when platform handles delivery', async () => {
        const delivery = makeDelivery();
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1');

        expect(delivery.payoutAmount).toBe(5.0);
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

        await service.confirmDelivery('delivery-1');

        expect(delivery.payoutAmount).toBeNull();
        expect(delivery.payoutStatus).toBeNull();
      });
    });

    describe('payment distribution for PIX', () => {
      it('should set vendor payout as split_auto (PIX now uses Checkout Pro)', async () => {
        const delivery = makeDelivery({
          order: makeOrder({ paymentMethod: 'PIX' }),
        });
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1');

        // PIX now uses same Checkout Pro with marketplace_fee — split_auto
        expect(delivery.vendorPayoutStatus).toBe('split_auto');
        expect(delivery.vendorPayoutAmount).toBe(47.5);
      });

      it('should set deliverer payout as pending_confirmation for PIX', async () => {
        const delivery = makeDelivery({
          order: makeOrder({ paymentMethod: 'PIX' }),
        });
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1');

        expect(delivery.payoutAmount).toBe(5.0);
        expect(delivery.payoutStatus).toBe('pending_confirmation');
      });
    });

    describe('payment distribution for ON_DELIVERY', () => {
      it('should NOT set any payout for cash payments', async () => {
        const delivery = makeDelivery({
          order: makeOrder({ paymentMethod: 'ON_DELIVERY' }),
        });
        deliveriesRepo.findOne.mockResolvedValue(delivery);
        deliveriesRepo.save.mockResolvedValue(delivery);

        await service.confirmDelivery('delivery-1');

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

      await service.confirmDelivery('delivery-1');

      expect(pubSub.publish).toHaveBeenCalledWith('deliveryUpdated', expect.any(Object));
    });
  });

  // ─── processDelivererPayout ─────────────────────────────────
  describe('processDelivererPayout', () => {
    it('should skip if delivery not found', async () => {
      deliveriesRepo.findOne.mockResolvedValue(null);
      await service.processDelivererPayout('bad-id');
      expect(paymentsService.transferToDeliverer).not.toHaveBeenCalled();
    });

    it('should skip if payoutStatus is not pending_confirmation or failed', async () => {
      deliveriesRepo.findOne.mockResolvedValue(makeDelivery({ payoutStatus: 'completed' }));
      await service.processDelivererPayout('delivery-1');
      expect(paymentsService.transferToDeliverer).not.toHaveBeenCalled();
    });

    it('should transfer delivery fee to deliverer on success', async () => {
      const delivery = makeDelivery({
        payoutStatus: 'pending_confirmation',
        payoutAmount: 5.0,
        order: makeOrder(),
        deliverer: makeDeliverer(),
      });
      deliveriesRepo.findOne.mockResolvedValue(delivery);
      paymentsService.transferToDeliverer.mockResolvedValue({ success: true, mpId: 'mp-123' });

      await service.processDelivererPayout('delivery-1');

      expect(paymentsService.transferToDeliverer).toHaveBeenCalledWith(
        'deliverer-1',
        5.0,
        'order-1',
      );
      expect(delivery.payoutStatus).toBe('completed');
      expect(delivery.payoutMpId).toBe('mp-123');
    });

    it('should set status to failed on transfer failure', async () => {
      const delivery = makeDelivery({
        payoutStatus: 'pending_confirmation',
        payoutAmount: 5.0,
        order: makeOrder(),
        deliverer: makeDeliverer(),
      });
      deliveriesRepo.findOne.mockResolvedValue(delivery);
      paymentsService.transferToDeliverer.mockResolvedValue({ success: false });

      await service.processDelivererPayout('delivery-1');

      expect(delivery.payoutStatus).toBe('failed');
    });

    it('should retry failed payouts', async () => {
      const delivery = makeDelivery({
        payoutStatus: 'failed',
        payoutAmount: 5.0,
        order: makeOrder(),
        deliverer: makeDeliverer(),
      });
      deliveriesRepo.findOne.mockResolvedValue(delivery);
      paymentsService.transferToDeliverer.mockResolvedValue({ success: true, mpId: 'mp-retry' });

      await service.processDelivererPayout('delivery-1');

      expect(delivery.payoutStatus).toBe('completed');
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
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        'delivery.payoutStatus = :status',
        { status: 'pending_confirmation' },
      );
      expect(mockQb.andWhere).toHaveBeenCalledWith('order.customerConfirmedAt IS NULL');
    });
  });

  // ─── findPendingPayouts ─────────────────────────────────────
  describe('findPendingPayouts', () => {
    it('should query only failed deliverer payouts', async () => {
      const mockQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      deliveriesRepo.createQueryBuilder.mockReturnValue(mockQb);

      await service.findPendingPayouts();

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        'delivery.payoutStatus = :failed',
        { failed: 'failed' },
      );
    });
  });

  // ─── findByDeliverer ────────────────────────────────────────
  describe('findByDeliverer', () => {
    it('should query deliveries for given deliverer', async () => {
      deliveriesRepo.find.mockResolvedValue([]);
      await service.findByDeliverer('d1');
      expect(deliveriesRepo.find).toHaveBeenCalledWith({
        where: { deliverer: { id: 'd1' } },
        relations: ['order', 'order.store', 'order.customer'],
        order: { createdAt: 'DESC' },
      });
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
