import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeliveryConfirmationScheduler } from './delivery-confirmation.scheduler';
import { OrdersService } from '../orders/orders.service';
import { Order } from '../orders/entities/order.entity';

describe('DeliveryConfirmationScheduler', () => {
  let scheduler: DeliveryConfirmationScheduler;
  let ordersService: any;
  let ordersRepo: any;

  const mockOrdersService = {
    expireAwaitingPaymentOrders: jest.fn(),
  };

  const mockOrdersRepo = {
    save: jest.fn((data) => Promise.resolve(data)),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryConfirmationScheduler,
        { provide: getRepositoryToken(Order), useValue: mockOrdersRepo },
        { provide: OrdersService, useValue: mockOrdersService },
      ],
    }).compile();

    scheduler = module.get<DeliveryConfirmationScheduler>(DeliveryConfirmationScheduler);
    ordersService = mockOrdersService;
    ordersRepo = mockOrdersRepo;
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
  });

  // ─── autoConfirmExpiredDeliveries ───────────────────────────
  describe('autoConfirmExpiredDeliveries', () => {
    it('should auto-confirm expired deliveries (set customerConfirmedAt)', async () => {
      const order = { id: 'order-1', customerConfirmedAt: null };
      const mockQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([order]),
      };
      mockOrdersRepo.createQueryBuilder.mockReturnValue(mockQb);

      await (scheduler as any).autoConfirmExpiredDeliveries();

      expect(order.customerConfirmedAt).toBeInstanceOf(Date);
      expect(ordersRepo.save).toHaveBeenCalledWith(order);
    });

    it('should process multiple expired deliveries', async () => {
      const orders = [
        { id: 'o1', customerConfirmedAt: null },
        { id: 'o2', customerConfirmedAt: null },
        { id: 'o3', customerConfirmedAt: null },
      ];
      const mockQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(orders),
      };
      mockOrdersRepo.createQueryBuilder.mockReturnValue(mockQb);

      await (scheduler as any).autoConfirmExpiredDeliveries();

      expect(ordersRepo.save).toHaveBeenCalledTimes(3);
    });

    it('should continue processing even if one order fails', async () => {
      const orders = [
        { id: 'o1', customerConfirmedAt: null },
        { id: 'o2', customerConfirmedAt: null },
      ];
      const mockQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(orders),
      };
      mockOrdersRepo.createQueryBuilder.mockReturnValue(mockQb);
      ordersRepo.save
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(orders[1]);

      await (scheduler as any).autoConfirmExpiredDeliveries();

      expect(ordersRepo.save).toHaveBeenCalledTimes(2);
    });

    it('should do nothing when no expired deliveries', async () => {
      const mockQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      mockOrdersRepo.createQueryBuilder.mockReturnValue(mockQb);

      await (scheduler as any).autoConfirmExpiredDeliveries();

      expect(ordersRepo.save).not.toHaveBeenCalled();
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
