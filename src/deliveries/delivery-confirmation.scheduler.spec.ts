import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeliveryConfirmationScheduler } from './delivery-confirmation.scheduler';
import { DeliveriesService } from './deliveries.service';
import { OrdersService } from '../orders/orders.service';
import { Order } from '../orders/entities/order.entity';

describe('DeliveryConfirmationScheduler', () => {
  let scheduler: DeliveryConfirmationScheduler;
  let deliveriesService: any;
  let ordersService: any;
  let ordersRepo: any;

  const mockDeliveriesService = {
    findExpiredPendingConfirmations: jest.fn(),
    processDelivererPayout: jest.fn(),
    findPendingPayouts: jest.fn(),
  };

  const mockOrdersService = {
    expireAwaitingPaymentOrders: jest.fn(),
  };

  const mockOrdersRepo = {
    save: jest.fn((data) => Promise.resolve(data)),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'MP_PAYER_EMAIL') return 'test@platform.com';
      return undefined;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryConfirmationScheduler,
        { provide: getRepositoryToken(Order), useValue: mockOrdersRepo },
        { provide: DeliveriesService, useValue: mockDeliveriesService },
        { provide: OrdersService, useValue: mockOrdersService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    scheduler = module.get<DeliveryConfirmationScheduler>(DeliveryConfirmationScheduler);
    deliveriesService = mockDeliveriesService;
    ordersService = mockOrdersService;
    ordersRepo = mockOrdersRepo;
  });

  afterEach(() => {
    // Clean up interval started by onModuleInit
    scheduler.onModuleDestroy();
  });

  // ─── autoConfirmExpiredDeliveries ───────────────────────────
  describe('autoConfirmExpiredDeliveries', () => {
    it('should auto-confirm deliveries and process deliverer payout', async () => {
      const delivery = {
        id: 'del-1',
        order: {
          id: 'order-1',
          customerConfirmedAt: null,
        },
      };
      deliveriesService.findExpiredPendingConfirmations.mockResolvedValue([delivery]);
      deliveriesService.processDelivererPayout.mockResolvedValue(undefined);

      // Trigger the private method via reflection
      await (scheduler as any).autoConfirmExpiredDeliveries();

      expect(delivery.order.customerConfirmedAt).toBeInstanceOf(Date);
      expect(ordersRepo.save).toHaveBeenCalledWith(delivery.order);
      expect(deliveriesService.processDelivererPayout).toHaveBeenCalledWith('del-1');
    });

    it('should process multiple expired deliveries', async () => {
      const deliveries = [
        { id: 'del-1', order: { id: 'o1', customerConfirmedAt: null } },
        { id: 'del-2', order: { id: 'o2', customerConfirmedAt: null } },
        { id: 'del-3', order: { id: 'o3', customerConfirmedAt: null } },
      ];
      deliveriesService.findExpiredPendingConfirmations.mockResolvedValue(deliveries);

      await (scheduler as any).autoConfirmExpiredDeliveries();

      expect(ordersRepo.save).toHaveBeenCalledTimes(3);
      expect(deliveriesService.processDelivererPayout).toHaveBeenCalledTimes(3);
    });

    it('should continue processing even if one delivery fails', async () => {
      const deliveries = [
        { id: 'del-1', order: { id: 'o1', customerConfirmedAt: null } },
        { id: 'del-2', order: { id: 'o2', customerConfirmedAt: null } },
      ];
      deliveriesService.findExpiredPendingConfirmations.mockResolvedValue(deliveries);
      deliveriesService.processDelivererPayout
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(undefined);

      await (scheduler as any).autoConfirmExpiredDeliveries();

      // Should still try the second one even if the first failed
      expect(deliveriesService.processDelivererPayout).toHaveBeenCalledTimes(2);
    });

    it('should do nothing when no expired deliveries', async () => {
      deliveriesService.findExpiredPendingConfirmations.mockResolvedValue([]);
      await (scheduler as any).autoConfirmExpiredDeliveries();
      expect(ordersRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── retryPendingPayouts ────────────────────────────────────
  describe('retryPendingPayouts', () => {
    it('should retry failed deliverer payouts', async () => {
      const delivery = { id: 'del-1', payoutStatus: 'failed' };
      deliveriesService.findPendingPayouts.mockResolvedValue([delivery]);

      await (scheduler as any).retryPendingPayouts();

      expect(deliveriesService.processDelivererPayout).toHaveBeenCalledWith('del-1');
    });

    it('should NOT process vendor payouts (handled by marketplace_fee split)', async () => {
      const delivery = {
        id: 'del-1',
        payoutStatus: 'completed',
        vendorPayoutStatus: 'split_auto',
      };
      deliveriesService.findPendingPayouts.mockResolvedValue([delivery]);

      await (scheduler as any).retryPendingPayouts();

      // Vendor payout is split_auto — no manual processing needed
      expect(deliveriesService.processDelivererPayout).not.toHaveBeenCalled();
    });

    it('should handle empty pending payouts list', async () => {
      deliveriesService.findPendingPayouts.mockResolvedValue([]);
      await (scheduler as any).retryPendingPayouts();
      expect(deliveriesService.processDelivererPayout).not.toHaveBeenCalled();
    });
  });

  // ─── expireAwaitingPaymentOrders ────────────────────────────
  describe('expireAwaitingPaymentOrders', () => {
    it('should call ordersService to expire orders', async () => {
      ordersService.expireAwaitingPaymentOrders.mockResolvedValue(3);
      await (scheduler as any).expireAwaitingPaymentOrders();
      expect(ordersService.expireAwaitingPaymentOrders).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      ordersService.expireAwaitingPaymentOrders.mockRejectedValue(new Error('db error'));
      await expect(
        (scheduler as any).expireAwaitingPaymentOrders(),
      ).resolves.not.toThrow();
    });
  });

  // ─── onModuleInit / onModuleDestroy ─────────────────────────
  describe('lifecycle', () => {
    it('should set up interval on init and clear on destroy', () => {
      const clearSpy = jest.spyOn(global, 'clearInterval');
      scheduler.onModuleInit();
      expect((scheduler as any).intervalId).toBeDefined();

      scheduler.onModuleDestroy();
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });
  });
});
