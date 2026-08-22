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
    // KAN-254: a logica de auto-confirmacao saiu do scheduler e virou
    // `OrdersService.autoConfirmExpiredDeliveries()`. O scheduler hoje so
    // delega — por isso estes mocks.
    autoConfirmExpiredDeliveries: jest.fn().mockResolvedValue(0),
    retryFailedSettlements: jest.fn().mockResolvedValue(0),
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
  //
  // KAN-254: estes testes exercitavam a implementacao ANTIGA, quando o proprio
  // scheduler montava a query e salvava os pedidos. Essa logica migrou para
  // `OrdersService.autoConfirmExpiredDeliveries()` e o scheduler virou um
  // delegador fino — os testes ficaram batendo em `ordersRepo.save`, que nunca
  // mais e chamado aqui. Reescritos no mesmo padrao ja usado por
  // `expireAwaitingPaymentOrders` logo abaixo: verificar a delegacao e a
  // resiliencia a erro. A regra de negocio em si pertence ao spec do
  // OrdersService.
  describe('autoConfirmExpiredDeliveries', () => {
    it('should delegate to OrdersService', async () => {
      ordersService.autoConfirmExpiredDeliveries.mockResolvedValue(3);

      await (scheduler as any).autoConfirmExpiredDeliveries();

      expect(ordersService.autoConfirmExpiredDeliveries).toHaveBeenCalled();
    });

    it('should not touch the orders repository directly', async () => {
      ordersService.autoConfirmExpiredDeliveries.mockResolvedValue(2);

      await (scheduler as any).autoConfirmExpiredDeliveries();

      expect(ordersRepo.save).not.toHaveBeenCalled();
    });

    it('should swallow errors so the interval keeps running', async () => {
      ordersService.autoConfirmExpiredDeliveries.mockRejectedValue(new Error('db error'));

      await expect(
        (scheduler as any).autoConfirmExpiredDeliveries(),
      ).resolves.not.toThrow();
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
