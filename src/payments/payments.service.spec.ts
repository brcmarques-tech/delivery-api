import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
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

// Mock mercadopago module
jest.mock('mercadopago', () => ({
  MercadoPagoConfig: jest.fn().mockImplementation(() => ({})),
  Preference: jest.fn().mockImplementation(() => ({
    create: jest.fn(),
  })),
  Payment: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
  Customer: jest.fn().mockImplementation(() => ({
    search: jest.fn().mockResolvedValue({ results: [] }),
    create: jest.fn().mockResolvedValue({ id: 'mp-customer-1' }),
  })),
}));

const { Preference, Payment: MpPayment } = jest.requireMock('mercadopago');

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('PaymentsService', () => {
  let service: PaymentsService;
  let paymentsRepo: any;
  let storesRepo: any;
  let configService: any;
  let appUsersService: any;
  let vendorUsersService: any;
  let platformConfigService: any;
  let whatsAppService: any;
  let notificationsService: any;

  const mockPaymentsRepo = {
    create: jest.fn((data) => ({ id: 'payment-1', ...data })),
    save: jest.fn((data) => Promise.resolve({ id: 'payment-1', ...data })),
    findOne: jest.fn(),
    find: jest.fn(),
    manager: {
      getRepository: jest.fn(),
    },
  };

  const mockStoresRepo = {
    find: jest.fn().mockResolvedValue([]),
  };

  const configMap: Record<string, string> = {
    MP_ACCESS_TOKEN: 'TEST-token',
    MP_PUBLIC_KEY: 'TEST-public',
    MP_APP_ID: '123456',
    MP_CLIENT_SECRET: 'test-secret',
    MP_PAYER_EMAIL: 'platform@test.com',
    MP_SANDBOX: 'true',
    APP_URL: 'http://localhost:3000',
    VENDOR_APP_URL: 'http://localhost:3001',
    WEBHOOK_URL: 'http://localhost:3000',
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => configMap[key] ?? defaultValue ?? ''),
  };

  const mockAppUsersService = {
    findById: jest.fn(),
    updateMpCredentials: jest.fn(),
    updateMpCustomerId: jest.fn(),
    disconnectMp: jest.fn(),
  };

  const mockVendorUsersService = {
    findById: jest.fn(),
    updateMpCredentials: jest.fn(),
    updateMpCustomerId: jest.fn(),
    updateVendorPlan: jest.fn(),
    disconnectMp: jest.fn(),
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
        { provide: AppUsersService, useValue: mockAppUsersService },
        { provide: VendorUsersService, useValue: mockVendorUsersService },
        { provide: PlatformConfigService, useValue: mockPlatformConfigService },
        { provide: WhatsAppService, useValue: mockWhatsAppService },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    paymentsRepo = mockPaymentsRepo;
    storesRepo = mockStoresRepo;
    configService = mockConfigService;
    appUsersService = mockAppUsersService;
    vendorUsersService = mockVendorUsersService;
  });

  // ─── Helper factories ───────────────────────────────────────
  function makeCustomer(overrides: any = {}) {
    return {
      id: 'customer-1',
      name: 'João Silva',
      email: 'joao@test.com',
      cpf: '12345678901',
      phone: '53999887766',
      mpCustomerId: null,
      ...overrides,
    };
  }

  function makeVendorUser(overrides: any = {}) {
    return {
      id: 'vendor-1',
      name: 'Maria Loja',
      email: 'maria@test.com',
      phone: '53999112233',
      mpAccessToken: 'vendor-mp-token',
      mpUserId: '12345',
      mpCustomerId: null,
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
      paymentMethod: 'MERCADO_PAGO',
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

  // ─── createOrderCheckout ────────────────────────────────────
  describe('createOrderCheckout', () => {
    it('should create a Checkout Pro preference with vendor token and marketplace_fee', async () => {
      const order = makeOrder();
      const customer = makeCustomer();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-123',
        init_point: 'https://mp.com/checkout',
        sandbox_init_point: 'https://sandbox.mp.com/checkout',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      const result = await service.createOrderCheckout(order, customer);

      // Should use sandbox_init_point when MP_SANDBOX=true
      expect(result.checkoutUrl).toBe('https://sandbox.mp.com/checkout');
      expect(result.preferenceId).toBe('pref-123');

      // Verify preference body
      const body = mockPreferenceCreate.mock.calls[0][0].body;
      expect(body.items[0].unit_price).toBe(55.0);
      expect(body.external_reference).toBe('order:order-1');
      // marketplace_fee = commission (2.5) + delivery fee (5.0) = 7.5
      expect(body.marketplace_fee).toBe(7.5);
    });

    it('should use init_point when MP_SANDBOX is not true', async () => {
      configMap.MP_SANDBOX = 'false';
      const order = makeOrder();
      const customer = makeCustomer();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-456',
        init_point: 'https://mp.com/checkout-prod',
        sandbox_init_point: 'https://sandbox.mp.com/checkout-prod',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      const result = await service.createOrderCheckout(order, customer);

      expect(result.checkoutUrl).toBe('https://mp.com/checkout-prod');
      configMap.MP_SANDBOX = 'true'; // restore
    });

    it('should NOT include delivery fee in marketplace_fee when store has own delivery', async () => {
      const order = makeOrder({
        store: makeStore({ hasOwnDelivery: true }),
      });
      const customer = makeCustomer();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-789',
        init_point: 'https://mp.com/checkout',
        sandbox_init_point: 'https://sandbox.mp.com/checkout',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      await service.createOrderCheckout(order, customer);

      const body = mockPreferenceCreate.mock.calls[0][0].body;
      // marketplace_fee = only commission (2.5), no delivery fee
      expect(body.marketplace_fee).toBe(2.5);
    });

    it('should not set marketplace_fee when no vendor token', async () => {
      const order = makeOrder({
        store: makeStore({ owner: { ...makeVendorUser(), mpAccessToken: null } }),
      });
      const customer = makeCustomer();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-no-vendor',
        init_point: 'https://mp.com/checkout',
        sandbox_init_point: 'https://sandbox.mp.com/checkout',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      await service.createOrderCheckout(order, customer);

      const body = mockPreferenceCreate.mock.calls[0][0].body;
      expect(body.marketplace_fee).toBeUndefined();
    });

    it('should include payer CPF and phone', async () => {
      const order = makeOrder();
      const customer = makeCustomer({ cpf: '999.888.777-66', phone: '5398765432' });
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-payer',
        init_point: 'https://mp.com/checkout',
        sandbox_init_point: 'https://sandbox.mp.com/checkout',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      await service.createOrderCheckout(order, customer);

      const body = mockPreferenceCreate.mock.calls[0][0].body;
      expect(body.payer.identification).toEqual({ type: 'CPF', number: '99988877766' });
    });
  });

  // ─── createOrderPix ─────────────────────────────────────────
  describe('createOrderPix', () => {
    it('should create a Checkout Pro preference with PIX-only payment methods', async () => {
      const order = makeOrder({ paymentMethod: 'PIX' });
      const customer = makeCustomer();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-pix-1',
        init_point: 'https://mp.com/checkout-pix',
        sandbox_init_point: 'https://sandbox.mp.com/checkout-pix',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      const result = await service.createOrderPix(order, customer);

      expect(result.checkoutUrl).toBe('https://sandbox.mp.com/checkout-pix');
      expect(result.preferenceId).toBe('pref-pix-1');

      const body = mockPreferenceCreate.mock.calls[0][0].body;
      // Should exclude all non-PIX payment types
      expect(body.payment_methods.excluded_payment_types).toEqual([
        { id: 'credit_card' },
        { id: 'debit_card' },
        { id: 'ticket' },
        { id: 'atm' },
      ]);
    });

    it('should include marketplace_fee with vendor token (same as checkout)', async () => {
      const order = makeOrder({ paymentMethod: 'PIX' });
      const customer = makeCustomer();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-pix-2',
        init_point: 'https://mp.com/checkout-pix',
        sandbox_init_point: 'https://sandbox.mp.com/checkout-pix',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      await service.createOrderPix(order, customer);

      const body = mockPreferenceCreate.mock.calls[0][0].body;
      // marketplace_fee = commission (2.5) + delivery fee (5.0) = 7.5
      expect(body.marketplace_fee).toBe(7.5);
    });

    it('should set PIX preference to expire in 30 minutes', async () => {
      const order = makeOrder({ paymentMethod: 'PIX' });
      const customer = makeCustomer();
      const before = Date.now();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-pix-exp',
        init_point: 'https://mp.com/checkout-pix',
        sandbox_init_point: 'https://sandbox.mp.com/checkout-pix',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      await service.createOrderPix(order, customer);

      const body = mockPreferenceCreate.mock.calls[0][0].body;
      expect(body.expires).toBe(true);
      const expiration = new Date(body.date_of_expiration).getTime();
      const expectedMin = before + 29 * 60 * 1000;
      const expectedMax = before + 31 * 60 * 1000;
      expect(expiration).toBeGreaterThanOrEqual(expectedMin);
      expect(expiration).toBeLessThanOrEqual(expectedMax);
    });

    it('should use vendor token when available', async () => {
      const vendorToken = 'vendor-specific-token';
      const order = makeOrder({
        paymentMethod: 'PIX',
        store: makeStore({ owner: makeVendorUser({ mpAccessToken: vendorToken }) }),
      });
      const customer = makeCustomer();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-pix-vendor',
        init_point: 'https://mp.com/checkout-pix',
        sandbox_init_point: 'https://sandbox.mp.com/checkout-pix',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      await service.createOrderPix(order, customer);

      // Verify MercadoPagoConfig was called with vendor token
      const { MercadoPagoConfig } = jest.requireMock('mercadopago');
      const calls = MercadoPagoConfig.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0].accessToken).toBe(vendorToken);
    });

    it('should include item description with weighted items', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        items: [
          { product: { name: 'Carne' }, quantity: 1, weightGrams: 500 },
          { product: { name: 'Queijo' }, quantity: 3, weightGrams: 0 },
        ],
      });
      const customer = makeCustomer();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-pix-desc',
        init_point: 'https://mp.com/checkout-pix',
        sandbox_init_point: 'https://sandbox.mp.com/checkout-pix',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));

      await service.createOrderPix(order, customer);

      const body = mockPreferenceCreate.mock.calls[0][0].body;
      expect(body.items[0].description).toBe('Carne (500g), 3x Queijo');
    });
  });

  // ─── getMpConnectUrl ────────────────────────────────────────
  describe('getMpConnectUrl', () => {
    it('should generate correct OAuth URL with encoded redirect', () => {
      const url = service.getMpConnectUrl('user-1', 'web');
      expect(url).toContain('client_id=123456');
      expect(url).toContain('state=user-1:web');
      expect(url).toContain('redirect_uri=');
      expect(url).toContain(encodeURIComponent('http://localhost:3000/payments/mp/callback'));
    });

    it('should use app source for mobile', () => {
      const url = service.getMpConnectUrl('user-2', 'app');
      expect(url).toContain('state=user-2:app');
    });
  });

  // ─── handleMpOAuthCallback ──────────────────────────────────
  describe('handleMpOAuthCallback', () => {
    it('should save vendor credentials on successful OAuth', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          user_id: 9999,
        }),
      });

      await service.handleMpOAuthCallback('auth-code', 'vendor-1', 'vendor');

      expect(vendorUsersService.updateMpCredentials).toHaveBeenCalledWith(
        'vendor-1',
        'new-access-token',
        'new-refresh-token',
        '9999',
      );
    });

    it('should save app user credentials when userType is app', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({
          access_token: 'app-token',
          refresh_token: 'app-refresh',
          user_id: 8888,
        }),
      });

      await service.handleMpOAuthCallback('auth-code', 'app-user-1', 'app');

      expect(appUsersService.updateMpCredentials).toHaveBeenCalledWith(
        'app-user-1',
        'app-token',
        'app-refresh',
        '8888',
      );
    });

    it('should not crash on OAuth failure', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ error: 'invalid_code' }),
      });

      await expect(
        service.handleMpOAuthCallback('bad-code', 'user-1', 'vendor'),
      ).resolves.not.toThrow();

      expect(vendorUsersService.updateMpCredentials).not.toHaveBeenCalled();
    });
  });

  // ─── handleWebhook ──────────────────────────────────────────
  describe('handleWebhook', () => {
    it('should ignore non-payment webhook types', async () => {
      await service.handleWebhook({ type: 'merchant_order', action: 'updated' });
      // No error, no calls
      expect(paymentsRepo.manager.getRepository).not.toHaveBeenCalled();
    });

    it('should ignore if no payment id', async () => {
      await service.handleWebhook({ type: 'payment', action: 'payment.created', data: {} });
      expect(paymentsRepo.manager.getRepository).not.toHaveBeenCalled();
    });

    it('should approve order on payment.created with approved status', async () => {
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

      const mockMpGet = jest.fn().mockResolvedValue({
        external_reference: 'order:order-1',
        status: 'approved',
        preference_id: 'pref-1',
      });
      MpPayment.mockImplementation(() => ({ get: mockMpGet }));

      await service.handleWebhook({
        type: 'payment',
        action: 'payment.created',
        data: { id: 12345 },
      });

      expect(mockOrderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: OrderStatus.PENDING }),
      );
    });

    it('should NOT approve order if already past AWAITING_PAYMENT', async () => {
      const mockOrder = {
        id: 'order-2',
        orderNumber: '1002',
        status: OrderStatus.PENDING,
        customer: { id: 'c1' },
      };
      const mockOrderRepo = {
        findOne: jest.fn().mockResolvedValue(mockOrder),
        save: jest.fn(),
      };
      paymentsRepo.manager.getRepository.mockReturnValue(mockOrderRepo);

      const mockMpGet = jest.fn().mockResolvedValue({
        external_reference: 'order:order-2',
        status: 'approved',
      });
      MpPayment.mockImplementation(() => ({ get: mockMpGet }));

      await service.handleWebhook({
        type: 'payment',
        action: 'payment.updated',
        data: { id: 99 },
      });

      expect(mockOrderRepo.save).not.toHaveBeenCalled();
    });

    it('should handle promo payment webhook', async () => {
      const mockPromotion = { id: 'promo-1', isPaid: false, product: { id: 'prod-1' }, promotionalPrice: 9.99, startDate: new Date(Date.now() - 86400000), endDate: new Date(Date.now() + 86400000) };
      const mockPromoRepo = { findOne: jest.fn().mockResolvedValue(mockPromotion), save: jest.fn() };
      const mockProductRepo = { update: jest.fn() };
      const mockPaymentRecord = { mpPaymentId: null, status: 'pending' };

      paymentsRepo.manager.getRepository.mockImplementation((entity: any) => {
        if (entity === 'Product') return mockProductRepo;
        return mockPromoRepo;
      });
      paymentsRepo.findOne.mockResolvedValue(mockPaymentRecord);
      paymentsRepo.save.mockResolvedValue(mockPaymentRecord);

      const mockMpGet = jest.fn().mockResolvedValue({
        external_reference: 'promo:promo-1',
        status: 'approved',
        preference_id: 'pref-promo',
      });
      MpPayment.mockImplementation(() => ({ get: mockMpGet }));

      await service.handleWebhook({
        type: 'payment',
        action: 'payment.created',
        data: { id: 555 },
      });

      expect(mockPromoRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isPaid: true }),
      );
      expect(mockProductRepo.update).toHaveBeenCalledWith('prod-1', { promotionalPrice: 9.99 });
    });

    it('should handle plan upgrade webhook', async () => {
      const mockMpGet = jest.fn().mockResolvedValue({
        external_reference: 'vendor-1:PREMIUM:3',
        status: 'approved',
        preference_id: 'pref-plan',
      });
      MpPayment.mockImplementation(() => ({ get: mockMpGet }));

      const mockPaymentRecord = { mpPaymentId: null, status: 'pending', vendorUser: { id: 'vendor-1' } };
      paymentsRepo.findOne.mockResolvedValue(mockPaymentRecord);
      paymentsRepo.save.mockResolvedValue(mockPaymentRecord);

      await service.handleWebhook({
        type: 'payment',
        action: 'payment.updated',
        data: { id: 777 },
      });

      expect(vendorUsersService.updateVendorPlan).toHaveBeenCalledWith(
        'vendor-1',
        'PREMIUM',
        3,
      );
    });
  });

  // ─── transferToVendor ───────────────────────────────────────
  describe('transferToVendor', () => {
    it('should fail if vendor has no mpUserId', async () => {
      vendorUsersService.findById.mockResolvedValue({ id: 'v1', mpUserId: null });
      const result = await service.transferToVendor('v1', 100, 'order-1');
      expect(result.success).toBe(false);
    });

    it('should fail if MP_PAYER_EMAIL not configured', async () => {
      vendorUsersService.findById.mockResolvedValue({ id: 'v1', mpUserId: '12345' });
      const original = configMap.MP_PAYER_EMAIL;
      configMap.MP_PAYER_EMAIL = '';

      const result = await service.transferToVendor('v1', 100, 'order-1');
      expect(result.success).toBe(false);

      configMap.MP_PAYER_EMAIL = original;
    });

    it('should succeed on approved payment response', async () => {
      vendorUsersService.findById.mockResolvedValue({ id: 'v1', mpUserId: '12345' });
      mockFetch.mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ id: 999, status: 'approved' }),
      });

      const result = await service.transferToVendor('v1', 47.5, 'order-1');

      expect(result.success).toBe(true);
      expect(result.mpId).toBe('999');
      expect(paymentsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'VENDOR_PAYOUT',
          amount: 47.5,
          status: 'approved',
        }),
      );
    });

    it('should fail on rejected payment response', async () => {
      vendorUsersService.findById.mockResolvedValue({ id: 'v1', mpUserId: '12345' });
      mockFetch.mockResolvedValueOnce({
        status: 400,
        json: () => Promise.resolve({ status: 'rejected', message: 'insufficient_amount' }),
      });

      const result = await service.transferToVendor('v1', 100, 'order-1');
      expect(result.success).toBe(false);
    });

    it('should handle network error gracefully', async () => {
      vendorUsersService.findById.mockResolvedValue({ id: 'v1', mpUserId: '12345' });
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.transferToVendor('v1', 100, 'order-1');
      expect(result.success).toBe(false);
    });
  });

  // ─── transferToDeliverer ────────────────────────────────────
  describe('transferToDeliverer', () => {
    it('should fail if deliverer has no mpUserId', async () => {
      appUsersService.findById.mockResolvedValue({ id: 'd1', mpUserId: null });
      const result = await service.transferToDeliverer('d1', 5, 'order-1');
      expect(result.success).toBe(false);
    });

    it('should succeed on approved payment', async () => {
      appUsersService.findById.mockResolvedValue({ id: 'd1', mpUserId: '67890' });
      mockFetch.mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ id: 888, status: 'approved' }),
      });

      const result = await service.transferToDeliverer('d1', 5, 'order-1');

      expect(result.success).toBe(true);
      expect(result.mpId).toBe('888');
      expect(paymentsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DELIVERER_PAYOUT',
          amount: 5,
        }),
      );
    });

    it('should handle pending payment status', async () => {
      appUsersService.findById.mockResolvedValue({ id: 'd1', mpUserId: '67890' });
      mockFetch.mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ id: 111, status: 'pending' }),
      });

      const result = await service.transferToDeliverer('d1', 5, 'order-1');
      expect(result.success).toBe(true);
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

    it('should create payment with correct billing period', async () => {
      const user = makeVendorUser();
      const mockPreferenceCreate = jest.fn().mockResolvedValue({
        id: 'pref-plan-1',
        init_point: 'https://mp.com/plan',
      });
      Preference.mockImplementation(() => ({ create: mockPreferenceCreate }));
      storesRepo.find.mockResolvedValue([]);

      const result = await service.createPlanUpgrade(user, VendorPlan.PREMIUM, 'quarterly');

      expect(paymentsRepo.save).toHaveBeenCalled();
      const savedPayment = paymentsRepo.create.mock.calls[0][0];
      expect(savedPayment.type).toBe('PLAN_UPGRADE');
      expect(savedPayment.metadata.billingPeriod).toBe('quarterly');
      expect(savedPayment.metadata.durationMonths).toBe(3);
    });
  });

  // ─── disconnectMp ───────────────────────────────────────────
  describe('disconnectMp', () => {
    it('should disconnect vendor MP', async () => {
      await service.disconnectMpVendor('vendor-1');
      expect(vendorUsersService.disconnectMp).toHaveBeenCalledWith('vendor-1');
    });

    it('should disconnect app user MP', async () => {
      await service.disconnectMpApp('app-1');
      expect(appUsersService.disconnectMp).toHaveBeenCalledWith('app-1');
    });
  });

  // ─── findByVendor / findByAppUser ───────────────────────────
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
});
