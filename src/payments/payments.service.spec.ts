import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Payment } from './entities/payment.entity';
import { Store } from '../stores/entities/store.entity';
import { AppUsersService } from '../users/app-users.service';
import { VendorUsersService } from '../users/vendor-users.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VendorPlan, OrderStatus } from '../common/enums';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let paymentsRepo: any;
  let httpService: any;

  const mockPaymentsRepo = {
    create: jest.fn((data) => ({ id: 'payment-1', ...data })),
    save: jest.fn((data) => Promise.resolve({ id: 'payment-1', ...data })),
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
    }),
    manager: {
      getRepository: jest.fn(),
    },
  };

  const mockStoresRepo = {
    find: jest.fn().mockResolvedValue([]),
  };

  const configMap: Record<string, string> = {
    PAGARME_SECRET_KEY: 'sk_test_abc123',
    PAGARME_PUBLIC_KEY: 'pk_test_abc123',
    PAGARME_PLATFORM_RECIPIENT_ID: 'rp_platform_123',
    APP_URL: 'http://localhost:3000',
    VENDOR_APP_URL: 'http://localhost:3001',
    WEBHOOK_URL: 'http://localhost:3000',
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => configMap[key] ?? defaultValue ?? ''),
  };

  const mockHttpService = {
    axiosRef: {
      post: jest.fn(),
      get: jest.fn(),
      put: jest.fn(),
    },
  };

  const mockAppUsersService = {
    findById: jest.fn(),
    updatePagarmeRecipient: jest.fn(),
    disconnectPayment: jest.fn(),
  };

  const mockVendorUsersService = {
    findById: jest.fn(),
    updatePagarmeRecipient: jest.fn(),
    updateVendorPlan: jest.fn(),
    disconnectPayment: jest.fn(),
  };

  const mockPlatformConfigService = {
    getBadgeRewards: jest.fn().mockResolvedValue({ subscriptionDiscount: 0 }),
  };

  const mockWhatsAppService = {
    notifyPlanUpgrade: jest.fn().mockResolvedValue(undefined),
    sendText: jest.fn().mockResolvedValue(undefined),
  };

  const mockNotificationsService = {
    sendToAppUser: jest.fn().mockResolvedValue(undefined),
    sendToVendorUser: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: mockPaymentsRepo },
        { provide: getRepositoryToken(Store), useValue: mockStoresRepo },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: HttpService, useValue: mockHttpService },
        { provide: AppUsersService, useValue: mockAppUsersService },
        { provide: VendorUsersService, useValue: mockVendorUsersService },
        { provide: PlatformConfigService, useValue: mockPlatformConfigService },
        { provide: WhatsAppService, useValue: mockWhatsAppService },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    paymentsRepo = mockPaymentsRepo;
    httpService = mockHttpService;
  });

  // ─── Helper factories ───────────────────────────────────────
  function makeCustomer(overrides: any = {}) {
    return {
      id: 'customer-1',
      name: 'João Silva',
      email: 'joao@test.com',
      cpf: '12345678901',
      phone: '53999887766',
      ...overrides,
    };
  }

  function makeVendorUser(overrides: any = {}) {
    return {
      id: 'vendor-1',
      name: 'Maria Loja',
      email: 'maria@test.com',
      phone: '53999112233',
      pagarmeRecipientId: 'rp_vendor_123',
      paymentConnected: true,
      acceptedSubscriptionTermsAt: new Date(),
      ...overrides,
    };
  }

  function makeStore(overrides: any = {}) {
    return {
      id: 'store-1',
      name: 'Loja Teste',
      hasOwnDelivery: false,
      owner: makeVendorUser(),
      badgeClaimCount: 0,
      verificationLevel: 'NONE',
      ...overrides,
    };
  }

  function makeOrder(overrides: any = {}) {
    return {
      id: 'order-1',
      orderNumber: '1001',
      status: OrderStatus.AWAITING_PAYMENT,
      subtotal: 50.0,
      deliveryFee: 5.0,
      total: 55.0,
      commissionAmount: 2.5,
      paymentMethod: 'CREDIT_CARD',
      deliveryAddress: 'Rua Teste, 123',
      store: makeStore(),
      items: [
        { product: { name: 'Pizza' }, quantity: 1, weightGrams: 0 },
        { product: { name: 'Refrigerante' }, quantity: 2, weightGrams: 0 },
      ],
      customer: makeCustomer(),
      ...overrides,
    };
  }

  // ─── createOrderPix ─────────────────────────────────────────
  describe('createOrderPix', () => {
    it('should create a Pagar.me order with PIX payment and split rules', async () => {
      const order = makeOrder({ paymentMethod: 'PIX' });
      const customer = makeCustomer();

      // Mock customer creation
      httpService.axiosRef.post.mockImplementation((url: string) => {
        if (url.includes('/customers')) {
          return Promise.resolve({ data: { id: 'cus_123' } });
        }
        if (url.includes('/orders')) {
          return Promise.resolve({
            data: {
              id: 'or_pix_123',
              status: 'pending',
              charges: [{
                id: 'ch_123',
                status: 'pending',
                last_transaction: {
                  qr_code: 'pix-qr-code-string',
                  qr_code_url: 'https://api.pagar.me/qrcode/123',
                },
              }],
            },
          });
        }
        return Promise.resolve({ data: {} });
      });

      const result = await service.createOrderPix(order, customer);

      expect(result.preferenceId).toBe('or_pix_123');
      expect(result.qrCode).toBe('pix-qr-code-string');
      expect(result.qrCodeUrl).toBe('https://api.pagar.me/qrcode/123');

      // Verify the order body sent to Pagar.me
      const orderCall = httpService.axiosRef.post.mock.calls.find((c: any) => c[0].includes('/orders'));
      const body = orderCall[1];
      expect(body.payments[0].payment_method).toBe('pix');
      expect(body.payments[0].pix.expires_in).toBe(1800);
      expect(body.payments[0].split).toBeDefined();
      expect(body.payments[0].split.length).toBeGreaterThanOrEqual(2); // platform + vendor at minimum
    });

    it('should throw if vendor has no pagarmeRecipientId', async () => {
      const order = makeOrder({
        store: makeStore({ owner: makeVendorUser({ pagarmeRecipientId: null }) }),
      });
      const customer = makeCustomer();

      await expect(service.createOrderPix(order, customer)).rejects.toThrow(
        'Vendedor não cadastrou conta de recebimento',
      );
    });
  });

  // ─── buildSplitRules (tested via createOrderPix) ─────────────
  describe('split rules', () => {
    it('should include deliverer in split when platform handles delivery', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        delivery: {
          deliverer: { pagarmeRecipientId: 'rp_deliverer_456' },
        },
      });
      const customer = makeCustomer();

      httpService.axiosRef.post.mockImplementation((url: string) => {
        if (url.includes('/customers')) return Promise.resolve({ data: { id: 'cus_1' } });
        if (url.includes('/orders')) return Promise.resolve({
          data: { id: 'or_1', charges: [{ last_transaction: { qr_code: '', qr_code_url: '' } }] },
        });
        return Promise.resolve({ data: {} });
      });

      await service.createOrderPix(order, customer);

      const orderCall = httpService.axiosRef.post.mock.calls.find((c: any) => c[0].includes('/orders'));
      const splitRules = orderCall[1].payments[0].split;

      // Should have 3 splits: platform, vendor, deliverer
      expect(splitRules.length).toBe(3);

      const delivererSplit = splitRules.find((s: any) => s.recipient_id === 'rp_deliverer_456');
      expect(delivererSplit).toBeDefined();
      expect(delivererSplit.amount).toBe(500); // R$5.00 delivery fee in cents
      expect(delivererSplit.type).toBe('flat');
    });

    it('should NOT include deliverer split when store has own delivery', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        store: makeStore({ hasOwnDelivery: true }),
      });
      const customer = makeCustomer();

      httpService.axiosRef.post.mockImplementation((url: string) => {
        if (url.includes('/customers')) return Promise.resolve({ data: { id: 'cus_1' } });
        if (url.includes('/orders')) return Promise.resolve({
          data: { id: 'or_2', charges: [{ last_transaction: { qr_code: '', qr_code_url: '' } }] },
        });
        return Promise.resolve({ data: {} });
      });

      await service.createOrderPix(order, customer);

      const orderCall = httpService.axiosRef.post.mock.calls.find((c: any) => c[0].includes('/orders'));
      const splitRules = orderCall[1].payments[0].split;

      // No deliverer split
      const delivererSplit = splitRules.find((s: any) => s.recipient_id === 'rp_deliverer_456');
      expect(delivererSplit).toBeUndefined();
    });
  });

  // ─── handleWebhook ──────────────────────────────────────────
  describe('handleWebhook', () => {
    it('should approve order on order.paid webhook', async () => {
      const mockOrder = {
        id: 'order-1',
        orderNumber: '1001',
        status: OrderStatus.AWAITING_PAYMENT,
        total: 55.0,
        customer: { id: 'c1', phone: '53999887766' },
        store: { id: 's1' },
      };
      const mockOrderRepo = {
        findOne: jest.fn().mockResolvedValue(mockOrder),
        save: jest.fn().mockResolvedValue(mockOrder),
      };
      paymentsRepo.manager.getRepository.mockReturnValue(mockOrderRepo);

      await service.handleWebhook({
        type: 'order.paid',
        data: {
          id: 'or_123',
          code: 'order-order-1',
          metadata: { order_id: 'order-1', order_number: '1001' },
        },
      });

      expect(mockOrderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: OrderStatus.PENDING }),
      );
    });

    it('should NOT approve order if already past AWAITING_PAYMENT', async () => {
      const mockOrder = {
        id: 'order-2',
        status: OrderStatus.PENDING,
        customer: { id: 'c1' },
      };
      const mockOrderRepo = {
        findOne: jest.fn().mockResolvedValue(mockOrder),
        save: jest.fn(),
      };
      paymentsRepo.manager.getRepository.mockReturnValue(mockOrderRepo);

      await service.handleWebhook({
        type: 'order.paid',
        data: {
          id: 'or_456',
          metadata: { order_id: 'order-2' },
        },
      });

      expect(mockOrderRepo.save).not.toHaveBeenCalled();
    });

    it('should handle plan upgrade webhook', async () => {
      const mockPaymentRecord = { pagarmeOrderId: 'or_plan', status: 'pending' };
      paymentsRepo.findOne.mockResolvedValue(mockPaymentRecord);

      await service.handleWebhook({
        type: 'order.paid',
        data: {
          id: 'or_plan',
          metadata: {
            type: 'plan_upgrade',
            user_id: 'vendor-1',
            plan: 'PREMIUM',
            duration_months: '3',
          },
        },
      });

      expect(mockVendorUsersService.updateVendorPlan).toHaveBeenCalledWith(
        'vendor-1',
        'PREMIUM',
        3,
      );
    });

    it('should ignore unknown webhook types', async () => {
      await service.handleWebhook({ type: 'unknown.event', data: { id: 'test' } });
      expect(paymentsRepo.manager.getRepository).not.toHaveBeenCalled();
    });
  });

  // ─── createPlanUpgrade ──────────────────────────────────────
  describe('createPlanUpgrade', () => {
    it('should throw on invalid plan', async () => {
      const user = makeVendorUser();
      await expect(
        service.createPlanUpgrade(user, 'FREE' as VendorPlan),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if user has not accepted subscription terms', async () => {
      const user = makeVendorUser({ acceptedSubscriptionTermsAt: null });
      await expect(
        service.createPlanUpgrade(user, VendorPlan.PREMIUM),
      ).rejects.toThrow('aceitar o contrato');
    });

    it('should create payment link for plan upgrade', async () => {
      const user = makeVendorUser();
      mockStoresRepo.find.mockResolvedValue([]);
      httpService.axiosRef.post.mockResolvedValue({
        data: { id: 'pl_plan_123', url: 'https://pagar.me/pay/pl_plan_123' },
      });

      const result = await service.createPlanUpgrade(user, VendorPlan.PREMIUM, 'quarterly');

      expect(paymentsRepo.save).toHaveBeenCalled();
      const savedPayment = paymentsRepo.create.mock.calls[0][0];
      expect(savedPayment.type).toBe('PLAN_UPGRADE');
      expect(savedPayment.metadata.billingPeriod).toBe('quarterly');
      expect(savedPayment.metadata.durationMonths).toBe(3);
    });
  });

  // ─── registerRecipient ────────────────────────────────────────
  describe('registerVendorRecipient', () => {
    it('should create recipient and update vendor', async () => {
      mockVendorUsersService.findById.mockResolvedValue(makeVendorUser());
      httpService.axiosRef.post.mockResolvedValue({
        data: { id: 'rp_new_vendor' },
      });

      const result = await service.registerVendorRecipient('vendor-1', {
        name: 'Maria',
        email: 'maria@test.com',
        document: '12345678901',
        type: 'individual',
        phone: { ddd: '53', number: '999112233' },
        address: {
          street: 'Rua Teste',
          streetNumber: '123',
          neighborhood: 'Centro',
          city: 'Arroio Grande',
          state: 'RS',
          zipCode: '96330000',
        },
        bankAccount: {
          holderName: 'Maria',
          bank: '260',
          branchNumber: '0001',
          accountNumber: '12345',
          accountCheckDigit: '6',
          type: 'checking',
        },
      });

      expect(result.recipientId).toBe('rp_new_vendor');
      expect(mockVendorUsersService.updatePagarmeRecipient).toHaveBeenCalledWith('vendor-1', 'rp_new_vendor');
    });
  });

  // ─── disconnect ──────────────────────────────────────────────
  describe('disconnect', () => {
    it('should disconnect vendor payment', async () => {
      await service.disconnectVendor('vendor-1');
      expect(mockVendorUsersService.disconnectPayment).toHaveBeenCalledWith('vendor-1');
    });

    it('should disconnect app user payment', async () => {
      await service.disconnectApp('app-1');
      expect(mockAppUsersService.disconnectPayment).toHaveBeenCalledWith('app-1');
    });
  });

  // ─── findByVendor ────────────────────────────────────────────
  describe('findByVendor', () => {
    it('should query by vendor user id', async () => {
      paymentsRepo.find.mockResolvedValue([]);
      await service.findByVendor('v1');
      expect(paymentsRepo.find).toHaveBeenCalledWith({
        where: { vendorUser: { id: 'v1' } },
        order: { createdAt: 'DESC' },
      });
    });
  });

  // ─── platformRevenue ─────────────────────────────────────────
  describe('platformRevenue', () => {
    it('should return total approved plan + promo payments', async () => {
      const result = await service.platformRevenue();
      expect(result).toBe(0);
    });
  });
});
