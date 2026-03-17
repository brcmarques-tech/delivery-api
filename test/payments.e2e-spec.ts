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
import { HttpService } from '@nestjs/axios';

// Mock axios (HttpService) to avoid real Pagar.me API calls
const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();

describe('Payments E2E', () => {
  let app: INestApplication<App>;
  let customerToken: string;
  let vendorToken: string;
  let delivererToken: string;
  let superadminToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env',
          load: [() => ({
            DB_DATABASE: 'delivery_test_db',
            PAGARME_SECRET_KEY: 'sk_test_fake',
            PAGARME_PUBLIC_KEY: 'pk_test_fake',
            PAGARME_PLATFORM_RECIPIENT_ID: 'rp_platform_test',
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
            dropSchema: true,
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

    // Override HttpService to mock Pagar.me API calls
    const httpService = moduleFixture.get(HttpService);
    httpService.axiosRef.post = mockAxiosPost;
    httpService.axiosRef.get = mockAxiosGet;

    // Default mock responses for Pagar.me
    mockAxiosPost.mockImplementation((url: string, body: any) => {
      if (url.includes('/customers')) {
        return Promise.resolve({ data: { id: 'cus_test_123' } });
      }
      if (url.includes('/paymentlinks')) {
        return Promise.resolve({
          data: { id: 'pl_test_123', url: 'https://pagar.me/pay/pl_test_123' },
        });
      }
      if (url.includes('/orders')) {
        return Promise.resolve({
          data: {
            id: 'or_test_123',
            status: 'pending',
            charges: [{
              id: 'ch_test_123',
              last_transaction: {
                qr_code: 'test-pix-qr-code',
                qr_code_url: 'https://api.pagar.me/qrcode/test',
              },
            }],
          },
        });
      }
      if (url.includes('/recipients')) {
        return Promise.resolve({ data: { id: 'rp_new_test' } });
      }
      return Promise.resolve({ data: {} });
    });

    app = moduleFixture.createNestApplication();
    await app.init();

    // Wait for seed to complete
    await new Promise((r) => setTimeout(r, 2000));

    // Login all test users
    customerToken = await login('cliente@bcmtech.com', 'cliente123', 'app');
    delivererToken = await login('entregador@bcmtech.com', 'entrega123', 'app');
    superadminToken = await loginSuperadmin();
    vendorToken = await loginVendor('admin@bcmtech.com', 'admin123');

    // Register vendor as Pagar.me recipient
    const vendorRecipientData = JSON.stringify({
      name: "Vendor Test",
      email: "admin@bcmtech.com",
      document: "12345678901",
      type: "individual",
      phone: { ddd: "53", number: "999112233" },
      address: {
        street: "Rua Teste",
        streetNumber: "100",
        neighborhood: "Centro",
        city: "Pelotas",
        state: "RS",
        zipCode: "96010000",
      },
      bankAccount: {
        holderName: "Vendor Test",
        bank: "260",
        branchNumber: "0001",
        accountNumber: "12345",
        accountCheckDigit: "6",
        type: "checking",
      },
    });
    await gql(`
      mutation RegisterRecipient($data: String!) {
        registerRecipient(recipientData: $data)
      }
    `, { data: vendorRecipientData }, vendorToken);

    // Register deliverer as Pagar.me recipient
    const delivererRecipientData = JSON.stringify({
      name: "Entregador Test",
      email: "entregador@bcmtech.com",
      document: "98765432101",
      type: "individual",
      phone: { ddd: "53", number: "999334455" },
      address: {
        street: "Rua Entrega",
        streetNumber: "200",
        neighborhood: "Centro",
        city: "Pelotas",
        state: "RS",
        zipCode: "96010000",
      },
      bankAccount: {
        holderName: "Entregador Test",
        bank: "260",
        branchNumber: "0001",
        accountNumber: "67890",
        accountCheckDigit: "1",
        type: "checking",
      },
    });
    await gql(`
      mutation RegisterRecipient($data: String!) {
        registerRecipient(recipientData: $data)
      }
    `, { data: delivererRecipientData }, delivererToken);
  }, 60000);

  afterAll(async () => {
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
        .send({ type: 'order.paid', data: { id: 'or_99999', metadata: {} } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('should respond 200 even for unknown webhook types', async () => {
      const res = await request(app.getHttpServer())
        .post('/payments/webhook')
        .send({ type: 'unknown.event', data: { id: 'test' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('should process order payment webhook and update status', async () => {
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      // Create order with CREDIT_CARD payment
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
          paymentMethod: 'CREDIT_CARD',
          deliveryAddress: 'Rua Teste, 123',
          deliveryLatitude: -31.7654,
          deliveryLongitude: -52.3456,
        },
      }, customerToken);

      expect(createRes.body.errors).toBeUndefined();
      const order = createRes.body.data.createOrder;
      expect(order.status).toBe('AWAITING_PAYMENT');
      expect(order.checkoutUrl).toBeTruthy();

      // Simulate Pagar.me webhook for paid order
      const webhookRes = await request(app.getHttpServer())
        .post('/payments/webhook')
        .send({
          type: 'order.paid',
          data: {
            id: 'or_test_123',
            code: `order-${order.id}`,
            metadata: { order_id: order.id, order_number: order.orderNumber },
          },
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

  describe('PIX Order Flow', () => {
    it('should create PIX order with QR code data', async () => {
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
    });
  });

  // ─── CREDIT_CARD Order Flow ────────────────────────────────

  describe('CREDIT_CARD Order Flow', () => {
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
          paymentMethod: 'CREDIT_CARD',
          deliveryAddress: 'Rua Card, 789',
          deliveryLatitude: -31.7654,
          deliveryLongitude: -52.3456,
        },
      }, customerToken);

      expect(res.body.errors).toBeUndefined();
      const order = res.body.data.createOrder;
      expect(order.status).toBe('AWAITING_PAYMENT');
      expect(order.checkoutUrl).toContain('pagar.me');
    });
  });

  // ─── ON_DELIVERY Order Flow ─────────────────────────────────

  describe('ON_DELIVERY Order Flow', () => {
    it('should reject cash payment when store has payment connected (requires online payment)', async () => {
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      const res = await gql(`
        mutation CreateOrder($input: CreateOrderInput!) {
          createOrder(input: $input) {
            id
            status
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

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toBeTruthy();
    });
  });

  // ─── Full Delivery + Payment Flow ───────────────────────────

  describe('Full delivery and payment flow', () => {
    it('should process complete flow: order → payment → accept → pickup → deliver → confirm', async () => {
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      // 1. Customer creates order with CREDIT_CARD
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
          paymentMethod: 'CREDIT_CARD',
          deliveryAddress: 'Rua Full Flow, 999',
          deliveryLatitude: -31.7654,
          deliveryLongitude: -52.3456,
        },
      }, customerToken);

      expect(createRes.body.errors).toBeUndefined();
      const order = createRes.body.data.createOrder;
      expect(order.status).toBe('AWAITING_PAYMENT');

      // Simulate payment approval via Pagar.me webhook
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .send({
          type: 'order.paid',
          data: {
            id: 'or_test_123',
            code: `order-${order.id}`,
            metadata: { order_id: order.id, order_number: order.orderNumber },
          },
        });

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

      // 6. Deliverer confirms pickup
      const pickupRes = await gql(`
        mutation { confirmPickup(deliveryId: "${delivery.id}") { id pickedUpAt } }
      `, {}, delivererToken);
      expect(pickupRes.body.data.confirmPickup.pickedUpAt).toBeTruthy();

      // 7. Deliverer confirms delivery
      const deliverRes = await gql(`
        mutation { confirmDelivery(deliveryId: "${delivery.id}") { id deliveredAt payoutStatus vendorPayoutStatus } }
      `, {}, delivererToken);
      const delivered = deliverRes.body.data.confirmDelivery;
      expect(delivered.deliveredAt).toBeTruthy();
      expect(delivered.vendorPayoutStatus).toBe('split_auto');
      expect(delivered.payoutStatus).toBe('split_auto');

      // 8. Customer confirms receipt
      const confirmRes = await gql(`
        mutation { confirmReceipt(orderId: "${order.id}") { id status customerConfirmedAt } }
      `, {}, customerToken);
      expect(confirmRes.body.data.confirmReceipt.customerConfirmedAt).toBeTruthy();
    });
  });

  // ─── Payment Distribution Tests ─────────────────────────────

  describe('Payment distribution on delivery confirmation', () => {
    it('should set split_auto for both PIX and CREDIT_CARD vendor payouts', async () => {
      const storeId = await getOrCreateTestStore();
      const productId = await getOrCreateTestProduct(storeId);

      for (const paymentMethod of ['PIX', 'CREDIT_CARD']) {
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

        // Simulate payment approval
        await request(app.getHttpServer())
          .post('/payments/webhook')
          .send({
            type: 'order.paid',
            data: {
              id: 'or_test_123',
              code: `order-${order.id}`,
              metadata: { order_id: order.id },
            },
          });

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
        // Both PIX and CREDIT_CARD should use split_auto (Pagar.me split)
        expect(d.vendorPayoutStatus).toBe('split_auto');
        expect(Number(d.vendorPayoutAmount)).toBeGreaterThan(0);
        expect(d.payoutStatus).toBe('split_auto');
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

  // ─── REST Endpoints ─────────────────────────────────────────

  describe('REST payment endpoints', () => {
    it('GET /payments/order-result should redirect to deep link', async () => {
      const res = await request(app.getHttpServer())
        .get('/payments/order-result?status=success&order=order-123');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('delivery-app://order-result?status=success&order=order-123');
    });
  });

  // ─── Helper: get or create store/product ────────────────────

  let cachedStoreId: string;
  let productCounter = 0;

  async function getOrCreateTestStore(): Promise<string> {
    if (cachedStoreId) return cachedStoreId;

    const storesRes = await gql(`query { stores { id name } }`, {}, customerToken);
    if (storesRes.body.data?.stores?.length > 0) {
      cachedStoreId = storesRes.body.data.stores[0].id;
      return cachedStoreId;
    }

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
    return createRes.body.data.createProduct.id;
  }
});
