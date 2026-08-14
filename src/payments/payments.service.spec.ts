import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Payment } from './entities/payment.entity';
import { Store } from '../stores/entities/store.entity';
// KAN-254: dependencias que foram adicionadas ao PaymentsService com o tempo
// mas nunca chegaram neste spec — o modulo de teste nem instanciava o service,
// derrubando TODOS os 16 testes deste arquivo com "Nest can't resolve
// dependencies". Os testes em si estavam certos; faltava a fiacao.
import { SavedCard } from './entities/saved-card.entity';
import { WebhookEvent } from './entities/webhook-event.entity';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionPlansService } from './subscription-plans.service';
import { PUB_SUB } from '../pubsub/pubsub.module';
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

  // KAN-254: varios metodos do service fazem
  // `paymentsRepository.manager.getRepository(Order)` e depois usam
  // createQueryBuilder/update/query nesse repo. O mock antigo devolvia
  // `undefined` em getRepository, entao esses testes quebravam com
  // "createQueryBuilder is not a function" / "cannot read property of
  // undefined" — nao era falha de logica, era mock incompleto.
  const mockOrderRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn((d: any) => Promise.resolve(d)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
      getMany: jest.fn().mockResolvedValue([]),
    }),
    // O guard atomico de settlement faz um UPDATE ... RETURNING id e so segue
    // se vier linha. Retornar uma linha mantem o caminho feliz dos testes.
    manager: {
      query: jest.fn().mockResolvedValue([{ id: 'order-1' }]),
    },
  };

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
      getRepository: jest.fn(() => mockOrderRepo),
      query: jest.fn().mockResolvedValue([{ id: 'order-1' }]),
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
    findByCpfWithRecipient: jest.fn().mockResolvedValue(null),
    updatePagarmeRecipient: jest.fn(),
    disconnectPayment: jest.fn(),
  };

  const mockVendorUsersService = {
    findById: jest.fn(),
    findByCpfWithRecipient: jest.fn().mockResolvedValue(null),
    updatePagarmeRecipient: jest.fn(),
    updateVendorPlan: jest.fn(),
    disconnectPayment: jest.fn(),
  };

  const mockPlatformConfigService = {
    getBadgeRewards: jest.fn().mockResolvedValue({ subscriptionDiscount: 0 }),
    getDeliveryCommissionPercent: jest.fn().mockResolvedValue(1),
    // KAN-254: `createPlanUpgrade` usa getPlanConfig, que nao existia no mock —
    // os 3 testes daquele bloco falhavam com TypeError em vez de exercitar a
    // regra de negocio. Default: PRO valido; cada teste sobrescreve conforme o
    // cenario (plano invalido, contact-sales, etc.).
    getPlanConfig: jest.fn().mockResolvedValue({
      monthlyPrice: 49.9,
      isContactSales: false,
    }),
  };

  const mockWhatsAppService = {
    notifyPlanUpgrade: jest.fn().mockResolvedValue(undefined),
    sendText: jest.fn().mockResolvedValue(undefined),
  };

  const mockNotificationsService = {
    sendToAppUser: jest.fn().mockResolvedValue(undefined),
    sendToVendorUser: jest.fn().mockResolvedValue(undefined),
  };

  // KAN-254: fabrica de repositorio mockado para as dependencias que o spec
  // nao exercita, mas que o Nest precisa resolver para instanciar o service.
  const mockRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation((e: any) => Promise.resolve(e)),
    create: jest.fn().mockImplementation((e: any) => e),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: { query: jest.fn().mockResolvedValue([]), getRepository: jest.fn() },
  });

  const mockSubscriptionPlansService = {
    getPlanConfig: jest.fn().mockResolvedValue({}),
    findAll: jest.fn().mockResolvedValue([]),
    // KAN-254: usado por createPlanUpgrade para resolver o plano no Pagar.me.
    getPagarmePlan: jest.fn().mockResolvedValue({
      id: 'plan_pagarme_123',
      pagarmePlanId: 'plan_pagarme_123',
    }),
  };

  const mockPubSub = { publish: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();

    // KAN-254: `jest.clearAllMocks()` limpa as CHAMADAS, mas NAO remove
    // implementacoes definidas com `mockReturnValue`. Alguns testes de
    // settlePayment sobrescrevem `manager.getRepository` com um mock local
    // magro, e esse override vazava para os testes seguintes (platformRevenue
    // quebrava com "createQueryBuilder is not a function"). Restaurar o padrao
    // aqui isola cada teste.
    mockPaymentsRepo.manager.getRepository.mockReturnValue(mockOrderRepo);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: mockPaymentsRepo },
        { provide: getRepositoryToken(Store), useValue: mockStoresRepo },
        // KAN-254: providers que faltavam (o service ganhou essas dependencias
        // e o spec nao acompanhou). Mocks minimos — nenhum teste deste arquivo
        // exercita esses caminhos; eles so precisam existir para o Nest montar.
        { provide: getRepositoryToken(SavedCard), useValue: mockRepo() },
        { provide: getRepositoryToken(WebhookEvent), useValue: mockRepo() },
        { provide: getRepositoryToken(Subscription), useValue: mockRepo() },
        { provide: SubscriptionPlansService, useValue: mockSubscriptionPlansService },
        { provide: PUB_SUB, useValue: mockPubSub },
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
    it('should create a Pagar.me order with PIX payment WITHOUT split (platform holds funds)', async () => {
      const order = makeOrder({ paymentMethod: 'PIX' });
      const customer = makeCustomer();

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

      // Verify NO split rules — all money goes to platform
      const orderCall = httpService.axiosRef.post.mock.calls.find((c: any) => c[0].includes('/orders'));
      const body = orderCall[1];
      expect(body.payments[0].payment_method).toBe('pix');
      expect(body.payments[0].pix.expires_in).toBe(1800);
      expect(body.payments[0].split).toBeUndefined();
    });
  });

  // ─── settlePayment (post-delivery transfers) ─────────────
  describe('settlePayment', () => {
    it('should transfer to vendor and deliverer after delivery', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        isPickup: false,
        delivery: {
          deliverer: { pagarmeRecipientId: 'rp_deliverer_456' },
        },
      });

      httpService.axiosRef.post.mockResolvedValue({
        data: { id: 'tr_123', status: 'pending' },
      });

      await service.settlePayment(order);

      // Should make 2 transfer calls: deliverer + vendor
      const transferCalls = httpService.axiosRef.post.mock.calls.filter(
        (c: any) => c[0].includes('/transfers'),
      );
      expect(transferCalls.length).toBe(2);

      // Deliverer transfer: R$5.00 delivery fee - 1% commission = R$4.95 = 495 cents
      const delivererCall = transferCalls.find((c: any) => c[1].recipient_id === 'rp_deliverer_456');
      expect(delivererCall).toBeDefined();
      expect(delivererCall[1].amount).toBe(495);

      // Vendor transfer: R$55.00 total - R$2.50 commission - R$5.00 delivery fee = R$47.50 = 4750 cents
      const vendorCall = transferCalls.find((c: any) => c[1].recipient_id === 'rp_vendor_123');
      expect(vendorCall).toBeDefined();
      expect(vendorCall[1].amount).toBe(4750);
    });

    it('should NOT transfer delivery fee when store has own delivery', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        isPickup: false,
        store: makeStore({ hasOwnDelivery: true }),
      });

      httpService.axiosRef.post.mockResolvedValue({
        data: { id: 'tr_456', status: 'pending' },
      });

      await service.settlePayment(order);

      const transferCalls = httpService.axiosRef.post.mock.calls.filter(
        (c: any) => c[0].includes('/transfers'),
      );
      // Only vendor transfer (no deliverer)
      expect(transferCalls.length).toBe(1);

      // Vendor gets total - commission (no delivery fee deducted since store handles delivery)
      const vendorCall = transferCalls[0];
      expect(vendorCall[1].recipient_id).toBe('rp_vendor_123');
      expect(vendorCall[1].amount).toBe(5250); // R$55.00 - R$2.50 = R$52.50 = 5250 cents
    });

    it('should handle pickup orders (no deliverer transfer)', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        isPickup: true,
      });

      httpService.axiosRef.post.mockResolvedValue({
        data: { id: 'tr_789', status: 'pending' },
      });

      await service.settlePayment(order);

      const transferCalls = httpService.axiosRef.post.mock.calls.filter(
        (c: any) => c[0].includes('/transfers'),
      );
      // Only vendor transfer
      expect(transferCalls.length).toBe(1);
      expect(transferCalls[0][1].recipient_id).toBe('rp_vendor_123');
      expect(transferCalls[0][1].amount).toBe(5250); // total - commission
    });

    // ─── Reembolso parcial de peso (onlinePaidTotal > total final) ─────
    // O ajuste de peso pode baixar o total DEPOIS do PIX pago; a diferenca
    // ficava em custodia com a plataforma, em silencio. Na liquidacao ela deve
    // voltar ao cliente via estorno parcial.
    it('should partially refund customer when paid amount exceeds final total', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        isPickup: true,
        onlinePaidTotal: 60.0, // pagou 60, peso final derrubou o total para 55
        mpPreferenceId: 'or_pix_123',
      });

      httpService.axiosRef.get.mockResolvedValue({
        data: { charges: [{ id: 'ch_abc', status: 'paid' }] },
      });
      httpService.axiosRef.post.mockResolvedValue({
        data: { id: 'tr_1', status: 'pending' },
      });

      await service.settlePayment(order);

      const refundCall = httpService.axiosRef.post.mock.calls.find(
        (c: any) => c[0].includes('/charges/ch_abc/refund'),
      );
      expect(refundCall).toBeDefined();
      expect(refundCall[1].amount).toBe(500); // 6000 - 5500 centavos
      // Idempotency-Key: um retry de settlement NAO pode estornar em dobro
      expect(refundCall[2].headers['Idempotency-Key']).toBe('weight-refund-order-1');
    });

    it('should NOT refund when paid amount equals final total', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        isPickup: true,
        onlinePaidTotal: 55.0, // igual ao total — nada a devolver
        mpPreferenceId: 'or_pix_123',
      });

      httpService.axiosRef.post.mockResolvedValue({
        data: { id: 'tr_1', status: 'pending' },
      });

      await service.settlePayment(order);

      const refundCalls = httpService.axiosRef.post.mock.calls.filter(
        (c: any) => c[0].includes('/refund'),
      );
      expect(refundCalls.length).toBe(0);
    });

    it('should release the refund claim and reopen settlement when the partial refund fails', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        isPickup: true,
        onlinePaidTotal: 60.0,
        mpPreferenceId: 'or_pix_123',
      });

      httpService.axiosRef.get.mockResolvedValue({
        data: { charges: [{ id: 'ch_abc', status: 'paid' }] },
      });
      httpService.axiosRef.post.mockImplementation((url: string) => {
        if (url.includes('/refund')) {
          return Promise.reject({ response: { data: { message: 'gateway down' } } });
        }
        return Promise.resolve({ data: { id: 'tr_1', status: 'pending' } });
      });

      await service.settlePayment(order);

      // Claim solto para o retry re-tentar (a Idempotency-Key impede duplicar)
      expect(mockOrderRepo.update).toHaveBeenCalledWith(
        'order-1',
        expect.objectContaining({ overpaidRefundedAt: null }),
      );
      // Settlement reaberto com o erro registrado
      expect(mockOrderRepo.update).toHaveBeenCalledWith(
        'order-1',
        expect.objectContaining({
          isSettled: false,
          notes: expect.stringContaining('weight_refund'),
        }),
      );
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
        // R#4: a confirmação virou um UPDATE ... RETURNING atômico (dedup entre
        // order.paid e charge.paid). Retornar uma linha = este webhook venceu o claim.
        manager: { query: jest.fn().mockResolvedValue([{ id: 'order-1' }]) },
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

      // A transição para PENDING agora é feita pelo UPDATE condicional atômico.
      expect(mockOrderRepo.manager.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'PENDING'"),
        expect.arrayContaining(['order-1']),
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

    // ─── Pagamento que chega APOS a expiracao ─────────────────
    // expireAwaitingPaymentOrders expira sem estornar (premissa: nao foi pago).
    // Se o cliente pagou aos 29:59 e o webhook chegou aos 30:05, o pedido ja
    // esta EXPIRED — antes o handler retornava em silencio e o dinheiro ficava
    // com a plataforma sem marcador nenhum.
    it('should auto-refund a payment that arrives after the order expired', async () => {
      const mockOrder = {
        id: 'order-9',
        orderNumber: '1009',
        status: OrderStatus.EXPIRED,
        total: 55.0,
        notes: '',
        customer: { id: 'c1', phone: '53999887766' },
        store: { id: 's1' },
      };
      const mockOrderRepo = {
        findOne: jest.fn().mockResolvedValue(mockOrder),
        save: jest.fn(),
        // claim do marcador [PAID_AFTER_EXPIRY] vence
        manager: { query: jest.fn().mockResolvedValue([{ id: 'order-9' }]) },
      };
      paymentsRepo.manager.getRepository.mockReturnValue(mockOrderRepo);

      httpService.axiosRef.get.mockResolvedValue({
        data: { id: 'ch_late', status: 'paid', amount: 5500 },
      });
      httpService.axiosRef.post.mockResolvedValue({ data: { id: 'ref_1' } });

      await service.handleWebhook({
        type: 'order.paid',
        data: {
          id: 'or_late',
          charges: [{ id: 'ch_late' }],
          metadata: { order_id: 'order-9' },
        },
      });

      const refundCall = httpService.axiosRef.post.mock.calls.find(
        (c: any) => c[0].includes('/charges/ch_late/refund'),
      );
      expect(refundCall).toBeDefined();
      expect(refundCall[1].amount).toBe(5500); // o valor REAL da cobranca
      expect(refundCall[2].headers['Idempotency-Key']).toBe('late-refund-order-9');
    });

    it('should NOT refund late payment when another webhook already claimed it', async () => {
      const mockOrder = {
        id: 'order-9',
        orderNumber: '1009',
        status: OrderStatus.EXPIRED,
        notes: '[PAID_AFTER_EXPIRY 2026-01-01] ja assumido',
        customer: { id: 'c1' },
        store: { id: 's1' },
      };
      const mockOrderRepo = {
        findOne: jest.fn().mockResolvedValue(mockOrder),
        save: jest.fn(),
        // claim perde: outro webhook (order.paid vs charge.paid) chegou antes
        manager: { query: jest.fn().mockResolvedValue([]) },
      };
      paymentsRepo.manager.getRepository.mockReturnValue(mockOrderRepo);

      await service.handleWebhook({
        type: 'order.paid',
        data: {
          id: 'or_late',
          charges: [{ id: 'ch_late' }],
          metadata: { order_id: 'order-9' },
        },
      });

      const refundCalls = httpService.axiosRef.post.mock.calls.filter(
        (c: any) => c[0].includes('/refund'),
      );
      expect(refundCalls.length).toBe(0);
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

      // KAN-254: o service passou a exigir `cardToken` para assinatura no
      // cartao (regra adicionada depois que este teste foi escrito). O teste
      // ficou desatualizado e falhava com BadRequestException antes de chegar
      // na asserção. Passando o token, ele volta a exercitar o que se propoe.
      const result = await service.createPlanUpgrade(
        user,
        VendorPlan.PREMIUM,
        'quarterly',
        'card_token_test',
      );

      expect(paymentsRepo.save).toHaveBeenCalled();
      const savedPayment = paymentsRepo.create.mock.calls[0][0];
      // KAN-254: o fluxo migrou de cobranca avulsa para ASSINATURA recorrente
      // no Pagar.me (chama POST /subscriptions, grava a entity Subscription e
      // preenche pagarmeSubscriptionId). O tipo do Payment passou de
      // 'PLAN_UPGRADE' para 'SUBSCRIPTION'. Verificado no proprio service antes
      // de ajustar aqui — o teste e que estava desatualizado, nao o codigo.
      expect(savedPayment.type).toBe('SUBSCRIPTION');
      expect(savedPayment.pagarmeSubscriptionId).toBeDefined();
      expect(savedPayment.description).toContain('PREMIUM');
    });
  });

  // ─── registerRecipient ────────────────────────────────────────
  describe('registerVendorRecipient', () => {
    it('should create recipient and update vendor', async () => {
      // Vendor without existing recipient
      // KAN-254/KAN-209: o recipient passou a usar SEMPRE o CPF do proprio
      // vendedor (antes aceitava o documento vindo do input, o que permitia
      // apontar o repasse para a conta de terceiro). O fixture nao tinha `cpf`,
      // entao o service barrava antes da asserção. Adicionado o CPF do dono.
      mockVendorUsersService.findById.mockResolvedValue(
        makeVendorUser({ pagarmeRecipientId: null, cpf: '12345678901' }),
      );
      mockAppUsersService.findById.mockResolvedValue(null);

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
