import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { AuthModule } from '../src/auth/auth.module';
import { UsersModule } from '../src/users/users.module';
import { StoresModule } from '../src/stores/stores.module';
import { ProductsModule } from '../src/products/products.module';
import { CategoriesModule } from '../src/categories/categories.module';
import { OrdersModule } from '../src/orders/orders.module';
import { DeliveriesModule } from '../src/deliveries/deliveries.module';
import { AddressesModule } from '../src/addresses/addresses.module';
import { DatabaseModule } from '../src/database/database.module';
import { DashboardModule } from '../src/dashboard/dashboard.module';
import { MailModule } from '../src/mail/mail.module';
import { UploadModule } from '../src/upload/upload.module';
import { PromotionsModule } from '../src/promotions/promotions.module';
import { PaymentsModule } from '../src/payments/payments.module';
import { PlatformConfigModule } from '../src/config/platform-config.module';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { PubSubModule } from '../src/pubsub/pubsub.module';
import { CouponsModule } from '../src/coupons/coupons.module';
import { WhatsAppModule } from '../src/whatsapp/whatsapp.module';

// Mock mercadopago to avoid real API calls
jest.mock('mercadopago', () => {
  const mockPreferenceCreate = jest.fn().mockResolvedValue({
    id: 'test-pref-id',
    init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=test',
    sandbox_init_point: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=test',
  });
  const mockPaymentGet = jest.fn();
  const mockCustomerSearch = jest.fn().mockResolvedValue({ results: [] });
  const mockCustomerCreate = jest.fn().mockResolvedValue({ id: 'mp-customer-test' });

  return {
    MercadoPagoConfig: jest.fn().mockImplementation(() => ({})),
    Preference: jest.fn().mockImplementation(() => ({
      create: mockPreferenceCreate,
    })),
    Payment: jest.fn().mockImplementation(() => ({
      get: mockPaymentGet,
    })),
    Customer: jest.fn().mockImplementation(() => ({
      search: mockCustomerSearch,
      create: mockCustomerCreate,
    })),
    __mockPreferenceCreate: mockPreferenceCreate,
    __mockPaymentGet: mockPaymentGet,
  };
});

const mp = jest.requireMock('mercadopago');

// Mock fetch for transfers
const originalFetch = global.fetch;
const mockFetch = jest.fn();

describe('Payments E2E', () => {
  let app: INestApplication<App>;
  let customerToken: string;
  let vendorToken: string;
  let delivererToken: string;
  let superadminToken: string;

  beforeAll(async () => {
    // Override fetch for transfer tests
    global.fetch = mockFetch as any;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env',
          load: [() => ({
            DB_DATABASE: 'delivery_test_db',
            MP_SANDBOX: 'true',
            MP_PAYER_EMAIL: 'test@platform.com',
          })],
        }),
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          useFactory: (config: ConfigService) => ({
            type: 'postgres',
            host: config.get('DB_HOST', 'localhost'),
            port: config.get<number>('DB_PORT', 5432),
            username: config.get('DB_USERNAME', 'delivery'),
            password: config.get('DB_PASSWORD', 'delivery123'),
            database: 'delivery_test_db',
            autoLoadEntities: true,
            synchronize: true,
            dropSchema: true, // Clean DB on each test run
          }),
          inject: [ConfigService],
        }),
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          sortSchema: true,
          playground: false,
          subscriptions: { 'graphql-ws': true },
          context: ({ req, extra }) => ({ req: req || extra?.request }),
        }),
        PubSubModule,
        AuthModule,
        UsersModule,
        StoresModule,
        ProductsModule,
        CategoriesModule,
        OrdersModule,
        DeliveriesModule,
        AddressesModule,
        DatabaseModule,
        DashboardModule,
        MailModule,
        UploadModule,
        PromotionsModule,
        PaymentsModule,
        PlatformConfigModule,
        NotificationsModule,
        CouponsModule,
        WhatsAppModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Wait for seed to complete
    await new Promise((r) => setTimeout(r, 2000));

    // Login all test users
    customerToken = await login('cliente@bcmtech.com', 'cliente123', 'app');
    delivererToken = await login('entregador@bcmtech.com', 'entrega123', 'app');
    superadminToken = await loginSuperadmin();
    vendorToken = await loginVendor('admin@bcmtech.com', 'admin123');

    // Connect vendor's MP account so the store can accept online payments
    // Simulate OAuth callback that saves MP credentials
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({
        access_token: 'vendor-test-mp-token',
        refresh_token: 'vendor-test-refresh',
        user_id: 999999,
      }),
    });
    // Get vendor ID from mpConnectUrl state param
    const urlRes = await gql(`query { mpConnectUrl }`, {}, vendorToken);
    const connectUrl = urlRes.body.data?.mpConnectUrl || '';
    const stateParam = connectUrl.match(/state=([^&]+)/)?.[1] || '';
    const vid = decodeURIComponent(stateParam).split(':')[0];
    await request(app.getHttpServer())
      .get(`/payments/mp/callback?code=setup-code&state=${vid}:web`);

    // Also connect deliverer's MP account
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({
        access_token: 'deliverer-test-mp-token',
        refresh_token: 'deliverer-test-refresh',
        user_id: 888888,
      }),
    });
    // Get deliverer ID from token
    const meRes = await gql(`query { meApp { id } }`, {}, delivererToken);
    const delivererId = meRes.body.data?.meApp?.id;
    if (delivererId) {
      await request(app.getHttpServer())
        .get(`/payments/mp/callback?code=setup-del-code&state=${delivererId}:app`);
    }
  }, 60000);

  afterAll(async () => {
    global.fetch = originalFetch;
    await app?.close();
  });

  // ─── Helper functions ───────────────────────────────────────

  async function gql(query: string, variables: any = {}, token?: string) {
    const req = request(app.getHttpServer())
      .post('/graphql')
      .send({ query, variables });
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  async function login(email: string, password: string, type: string = 'app'): Promise<string> {
    const mutation = type === 'app'
      ? `mutation { loginApp(input: { email: "${email}", password: "${password}" }) { accessToken } }`
      : `mutation { loginVendor(input: { email: "${email}", password: "${password}" }) { accessToken } }`;

    const res = await gql(mutation);
    const data = res.body.data;
    return data?.loginApp?.accessToken || data?.loginVendor?.accessToken;
  }

  async function loginVendor(email: string, password: string): Promise<string> {
    const res = await gql(
      `mutation { loginVendor(input: { email: "${email}", password: "${password}" }) { accessToken } }`,
    );
    return res.body.data?.loginVendor?.accessToken;
  }

  async function loginSuperadmin(): Promise<string> {
    const res = await gql(
      `mutation { loginApp(input: { email: "superadmin@bcmtech.com", password: "super123" }) { accessToken } }`,
    );
    return res.body.data?.loginApp?.accessToken;
  }

  // ─── Webhook Tests ──────────────────────────────────────────

  describe('POST /payments/webhook', () => {
    it('should respond 200 to valid webhook', async () => {
      const res = await request(app.getHttpServer())
        .post('/payments/webhook')
        .send({ type: 'payment', action: 'payment.created', data: { id: 99999 } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('should respond 200 even for unknown webhook types (just ignores)', async () => {
      const res = await request(app.getHttpServer())
        .post('/payments/webhook')
        .send({ type: 'merchant_order', action: 'updated' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('should process order payment webhook and update status', async () => {
      // First create a store, product, and order
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      // Create order with MERCADO_PAGO payment
      const createRes = await gql(`
        mutation CreateOrder($input: CreateOrderInput!) {
          createOrder(input: $input) {
            id
            orderNumber
            status
            checkoutUrl
            paymentMethod
          }
        }
      `, {
        input: {
          storeId,
          items: [{ productId, quantity: 1 }],
          paymentMethod: 'MERCADO_PAGO',
          deliveryAddress: 'Rua Teste, 123',
          deliveryLatitude: -31.7654,
          deliveryLongitude: -52.3456,
        },
      }, customerToken);

      expect(createRes.body.errors).toBeUndefined();
      const order = createRes.body.data.createOrder;
      expect(order.status).toBe('AWAITING_PAYMENT');
      expect(order.checkoutUrl).toBeTruthy();

      // Simulate MP webhook for approved payment
      mp.__mockPaymentGet.mockResolvedValueOnce({
        external_reference: `order:${order.id}`,
        status: 'approved',
        preference_id: 'test-pref-id',
      });

      const webhookRes = await request(app.getHttpServer())
        .post('/payments/webhook')
        .send({
          type: 'payment',
          action: 'payment.created',
          data: { id: 12345 },
        });

      expect(webhookRes.status).toBe(200);

      // Verify order status changed to PENDING
      const orderRes = await gql(`
        query { order(id: "${order.id}") { id status } }
      `, {}, customerToken);

      expect(orderRes.body.data.order.status).toBe('PENDING');
    });
  });

  // ─── PIX Order Flow ─────────────────────────────────────────

  describe('PIX Order via Checkout Pro', () => {
    it('should create PIX order with checkoutUrl (not qrCode)', async () => {
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      const res = await gql(`
        mutation CreateOrder($input: CreateOrderInput!) {
          createOrder(input: $input) {
            id
            orderNumber
            status
            checkoutUrl
            paymentMethod
          }
        }
      `, {
        input: {
          storeId,
          items: [{ productId, quantity: 2 }],
          paymentMethod: 'PIX',
          deliveryAddress: 'Rua PIX, 456',
          deliveryLatitude: -31.7654,
          deliveryLongitude: -52.3456,
        },
      }, customerToken);

      expect(res.body.errors).toBeUndefined();
      const order = res.body.data.createOrder;
      expect(order.status).toBe('AWAITING_PAYMENT');
      expect(order.paymentMethod).toBe('PIX');
      // PIX now returns checkoutUrl via Checkout Pro (sandbox URL)
      expect(order.checkoutUrl).toContain('sandbox.mercadopago');
    });
  });

  // ─── MERCADO_PAGO Order Flow ────────────────────────────────

  describe('MERCADO_PAGO Order Flow', () => {
    it('should create order with checkout URL', async () => {
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      const res = await gql(`
        mutation CreateOrder($input: CreateOrderInput!) {
          createOrder(input: $input) {
            id
            status
            checkoutUrl
            paymentMethod
          }
        }
      `, {
        input: {
          storeId,
          items: [{ productId, quantity: 1 }],
          paymentMethod: 'MERCADO_PAGO',
          deliveryAddress: 'Rua MP, 789',
          deliveryLatitude: -31.7654,
          deliveryLongitude: -52.3456,
        },
      }, customerToken);

      expect(res.body.errors).toBeUndefined();
      const order = res.body.data.createOrder;
      expect(order.status).toBe('AWAITING_PAYMENT');
      expect(order.checkoutUrl).toContain('sandbox.mercadopago');
    });
  });

  // ─── ON_DELIVERY Order Flow ─────────────────────────────────

  describe('ON_DELIVERY Order Flow', () => {
    it('should reject cash payment when store has MP connected (requires online payment)', async () => {
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      const res = await gql(`
        mutation CreateOrder($input: CreateOrderInput!) {
          createOrder(input: $input) {
            id
            status
            checkoutUrl
            paymentMethod
          }
        }
      `, {
        input: {
          storeId,
          items: [{ productId, quantity: 1 }],
          paymentMethod: 'ON_DELIVERY',
          deliveryAddress: 'Rua Cash, 101',
          deliveryLatitude: -31.7654,
          deliveryLongitude: -52.3456,
        },
      }, customerToken);

      // When vendor has MP connected, ON_DELIVERY may be disabled
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toContain('disponivel');
    });
  });

  // ─── Full Delivery + Payment Flow ───────────────────────────

  describe('Full delivery and payment flow', () => {
    it('should process complete flow: order → payment → accept → pickup → deliver → confirm', async () => {
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      // 1. Customer creates order with MERCADO_PAGO
      const createRes = await gql(`
        mutation CreateOrder($input: CreateOrderInput!) {
          createOrder(input: $input) {
            id
            orderNumber
            status
            total
            subtotal
            deliveryFee
          }
        }
      `, {
        input: {
          storeId,
          items: [{ productId, quantity: 1 }],
          paymentMethod: 'MERCADO_PAGO',
          deliveryAddress: 'Rua Full Flow, 999',
          deliveryLatitude: -31.7654,
          deliveryLongitude: -52.3456,
        },
      }, customerToken);

      expect(createRes.body.errors).toBeUndefined();
      const order = createRes.body.data.createOrder;
      expect(order.status).toBe('AWAITING_PAYMENT');

      // Simulate payment approval
      mp.__mockPaymentGet.mockResolvedValueOnce({
        external_reference: `order:${order.id}`,
        status: 'approved',
        preference_id: 'test-pref-id',
      });
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .send({ type: 'payment', action: 'payment.created', data: { id: Math.random() * 99999 | 0 } });

      // Verify order moved to PENDING
      const checkRes = await gql(`query { order(id: "${order.id}") { status } }`, {}, customerToken);
      expect(checkRes.body.data.order.status).toBe('PENDING');

      // 2. Vendor accepts order
      const acceptRes = await gql(`
        mutation { updateOrderStatus(id: "${order.id}", status: ACCEPTED) { id status } }
      `, {}, vendorToken);
      expect(acceptRes.body.data.updateOrderStatus.status).toBe('ACCEPTED');

      // 3. Vendor marks as preparing
      const prepRes = await gql(`
        mutation { updateOrderStatus(id: "${order.id}", status: PREPARING) { id status } }
      `, {}, vendorToken);
      expect(prepRes.body.data.updateOrderStatus.status).toBe('PREPARING');

      // 4. Vendor marks as ready
      const readyRes = await gql(`
        mutation { updateOrderStatus(id: "${order.id}", status: READY) { id status } }
      `, {}, vendorToken);
      expect(readyRes.body.data.updateOrderStatus.status).toBe('READY');

      // 5. Deliverer accepts delivery
      const delivAccept = await gql(`
        mutation { acceptDelivery(orderId: "${order.id}") { id } }
      `, {}, delivererToken);
      expect(delivAccept.body.errors).toBeUndefined();
      const delivery = delivAccept.body.data.acceptDelivery;

      // Verify order status updated to PICKED_UP
      const pickedUpCheck = await gql(`query { order(id: "${order.id}") { status } }`, {}, customerToken);
      expect(pickedUpCheck.body.data.order.status).toBe('PICKED_UP');

      // 6. Deliverer confirms pickup
      const pickupRes = await gql(`
        mutation { confirmPickup(deliveryId: "${delivery.id}") { id pickedUpAt } }
      `, {}, delivererToken);
      expect(pickupRes.body.data.confirmPickup.pickedUpAt).toBeTruthy();

      // Verify order status updated to DELIVERING
      const deliveringCheck = await gql(`query { order(id: "${order.id}") { status } }`, {}, customerToken);
      expect(deliveringCheck.body.data.order.status).toBe('DELIVERING');

      // 7. Deliverer confirms delivery
      const deliverRes = await gql(`
        mutation { confirmDelivery(deliveryId: "${delivery.id}") { id deliveredAt payoutStatus vendorPayoutStatus } }
      `, {}, delivererToken);
      const delivered = deliverRes.body.data.confirmDelivery;
      expect(delivered.deliveredAt).toBeTruthy();
      // MERCADO_PAGO: marketplace_fee splits automatically
      expect(delivered.vendorPayoutStatus).toBe('split_auto');
      expect(delivered.payoutStatus).toBe('pending_confirmation');

      // Verify order status updated to DELIVERED
      const deliveredCheck = await gql(`query { order(id: "${order.id}") { status } }`, {}, customerToken);
      expect(deliveredCheck.body.data.order.status).toBe('DELIVERED');

      // 8. Customer confirms receipt
      const confirmRes = await gql(`
        mutation { confirmReceipt(orderId: "${order.id}") { id status customerConfirmedAt } }
      `, {}, customerToken);
      expect(confirmRes.body.data.confirmReceipt.customerConfirmedAt).toBeTruthy();
    });
  });

  // ─── Payment Distribution Tests ─────────────────────────────

  describe('Payment distribution on delivery confirmation', () => {
    it('should set split_auto for both PIX and MERCADO_PAGO vendor payouts', async () => {
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      for (const paymentMethod of ['PIX', 'MERCADO_PAGO']) {
        // Create order
        const createRes = await gql(`
          mutation CreateOrder($input: CreateOrderInput!) {
            createOrder(input: $input) { id status }
          }
        `, {
          input: {
            storeId,
            items: [{ productId, quantity: 1 }],
            paymentMethod,
            deliveryAddress: `Rua ${paymentMethod}, 123`,
            deliveryLatitude: -31.7654,
            deliveryLongitude: -52.3456,
          },
        }, customerToken);

        const order = createRes.body.data.createOrder;

        // Simulate payment approval for non-cash
        mp.__mockPaymentGet.mockResolvedValueOnce({
          external_reference: `order:${order.id}`,
          status: 'approved',
          preference_id: 'test-pref-id',
        });
        await request(app.getHttpServer())
          .post('/payments/webhook')
          .send({ type: 'payment', action: 'payment.created', data: { id: Math.random() * 99999 | 0 } });

        // Fast-forward: vendor accepts → ready
        await gql(`mutation { updateOrderStatus(id: "${order.id}", status: ACCEPTED) { id } }`, {}, vendorToken);
        await gql(`mutation { updateOrderStatus(id: "${order.id}", status: PREPARING) { id } }`, {}, vendorToken);
        await gql(`mutation { updateOrderStatus(id: "${order.id}", status: READY) { id } }`, {}, vendorToken);

        // Deliverer accepts + pickup + deliver
        const delAccept = await gql(`mutation { acceptDelivery(orderId: "${order.id}") { id } }`, {}, delivererToken);
        const delId = delAccept.body.data.acceptDelivery.id;
        await gql(`mutation { confirmPickup(deliveryId: "${delId}") { id } }`, {}, delivererToken);

        const deliverRes = await gql(`
          mutation { confirmDelivery(deliveryId: "${delId}") {
            id vendorPayoutStatus vendorPayoutAmount payoutStatus payoutAmount
          } }
        `, {}, delivererToken);

        const d = deliverRes.body.data.confirmDelivery;
        // Both PIX and MERCADO_PAGO should use split_auto (marketplace_fee)
        expect(d.vendorPayoutStatus).toBe('split_auto');
        expect(Number(d.vendorPayoutAmount)).toBeGreaterThan(0);
        // Deliverer payout should be pending_confirmation
        expect(d.payoutStatus).toBe('pending_confirmation');
        expect(Number(d.payoutAmount)).toBeGreaterThan(0);
      }
    });
  });

  // ─── Auth Guards ────────────────────────────────────────────

  describe('Auth guards on payment endpoints', () => {
    it('should reject unauthenticated access to myPayments', async () => {
      const res = await gql(`query { myPayments { id } }`);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toContain('Unauthorized');
    });

    it('should reject customer access to allPayments (SUPERADMIN only)', async () => {
      const res = await gql(`query { allPayments { id } }`, {}, customerToken);
      expect(res.body.errors).toBeDefined();
    });

    it('should allow superadmin to access allPayments', async () => {
      const res = await gql(`query { allPayments { id } }`, {}, superadminToken);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.allPayments).toBeDefined();
    });
  });

  // ─── MP Connect URL ────────────────────────────────────────

  describe('MP Connect URL', () => {
    it('should return OAuth URL for vendor', async () => {
      const res = await gql(`query { mpConnectUrl }`, {}, vendorToken);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.mpConnectUrl).toContain('auth.mercadopago.com.br');
      expect(res.body.data.mpConnectUrl).toContain('client_id=');
    });
  });

  // ─── REST Endpoints ─────────────────────────────────────────

  describe('REST payment endpoints', () => {
    it('GET /payments/mp/connect-url should return URL', async () => {
      const res = await request(app.getHttpServer())
        .get('/payments/mp/connect-url?userId=test-user-1');
      expect(res.status).toBe(200);
      expect(res.body.url).toContain('auth.mercadopago.com.br');
    });

    it('GET /payments/order-result should redirect to deep link', async () => {
      const res = await request(app.getHttpServer())
        .get('/payments/order-result?status=success&order=order-123');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('delivery-app://order-result?status=success&order=order-123');
    });

    it('GET /payments/mp/callback should handle vendor OAuth callback', async () => {
      // Get a real vendor ID first
      const meRes = await gql(`query { mpConnectUrl }`, {}, vendorToken);
      const vendorUrl = meRes.body.data?.mpConnectUrl || '';
      // Extract user ID from state param in the URL
      const stateMatch = vendorUrl.match(/state=([^&]+)/);
      const vendorState = stateMatch ? decodeURIComponent(stateMatch[1]) : '';
      const vendorId = vendorState.split(':')[0];

      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          user_id: 123456,
        }),
      });

      const res = await request(app.getHttpServer())
        .get(`/payments/mp/callback?code=test-auth-code&state=${vendorId}:web`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/dashboard?mp=connected');
    });

    it('GET /payments/mp/callback with app source should redirect to app deep link', async () => {
      // Mock OAuth - even with unknown user, should redirect (OAuth saves fail silently)
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({
          error: 'invalid_grant',
        }),
      });

      const res = await request(app.getHttpServer())
        .get('/payments/mp/callback?code=app-code&state=some-id:app');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('delivery-app://profile?mp=connected');
    });
  });

  // ─── Helper: get or create store/product ────────────────────

  let cachedStoreId: string;
  let productCounter = 0;

  async function getOrCreateTestStore(): Promise<string> {
    if (cachedStoreId) return cachedStoreId;

    // Query existing stores
    const storesRes = await gql(`query { stores { id name } }`, {}, customerToken);
    if (storesRes.body.data?.stores?.length > 0) {
      cachedStoreId = storesRes.body.data.stores[0].id;
      return cachedStoreId;
    }

    // Create a store via vendor
    const createRes = await gql(`
      mutation {
        createStore(input: {
          name: "Loja E2E Teste"
          description: "Loja para testes E2E"
          phone: "53999001122"
          street: "Rua Teste"
          number: "100"
          neighborhood: "Centro"
          city: "Pelotas"
          state: "RS"
          zipCode: "96010-000"
          latitude: -31.7654
          longitude: -52.3456
          deliveryFee: 5.00
        }) { id }
      }
    `, {}, vendorToken);

    if (!createRes.body.data?.createStore?.id) {
      console.error('createStore failed:', JSON.stringify(createRes.body.errors));
      throw new Error('Failed to create test store');
    }
    cachedStoreId = createRes.body.data.createStore.id;
    return cachedStoreId;
  }

  async function getOrCreateTestProduct(storeId: string): Promise<string> {
    // Always create a new product with stock to avoid "Estoque insuficiente" errors
    productCounter++;
    const createRes = await gql(`
      mutation {
        createProduct(input: {
          storeId: "${storeId}"
          name: "Produto E2E ${productCounter}"
          description: "Produto para testes"
          price: 25.00
          stock: 100
        }) { id }
      }
    `, {}, vendorToken);

    if (!createRes.body.data?.createProduct?.id) {
      console.error('createProduct failed:', JSON.stringify(createRes.body.errors));
      throw new Error('Failed to create test product');
    }
    const cachedProductId = createRes.body.data.createProduct.id;
    return cachedProductId;
  }
});
