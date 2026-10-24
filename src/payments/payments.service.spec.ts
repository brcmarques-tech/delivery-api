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
      // Faltava `delete` aqui, e isso tem consequencia: TODO caminho que usa
      // pagarmeDelete (estorno, void de pre-autorizacao, cancelamento de
      // assinatura) estourava "delete is not a function" dentro do try/catch e
      // era engolido como "falha do provedor". Nenhum desses caminhos chegou a
      // ser exercitado por teste.
      delete: jest.fn(),
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
    const pixOrderResponse = {
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
    };

    // C1 (split-on-charge): a cobranca PIX agora carrega split. O vendedor e
    // creditado no saldo dele no pagamento (nunca passa pela plataforma). O
    // /transfers antigo sacava do saldo ZERO do proprio recebedor e nunca
    // funcionava.
    it('should create a PIX order WITH split (vendor + platform)', async () => {
      const order = makeOrder({ paymentMethod: 'PIX' });
      const customer = makeCustomer();

      httpService.axiosRef.post.mockResolvedValue({ data: pixOrderResponse });

      const result = await service.createOrderPix(order, customer);

      expect(result.preferenceId).toBe('or_pix_123');
      expect(result.qrCode).toBe('pix-qr-code-string');
      expect(result.settledViaSplit).toBe(true);

      const orderCall = httpService.axiosRef.post.mock.calls.find((c: any) => c[0].includes('/orders'));
      const split = orderCall[1].payments[0].split;
      expect(Array.isArray(split)).toBe(true);
      // Entrega externa: vendedor = 5500 - 250 (comissao) - 500 (frete) = 4750;
      // plataforma retem 750 (comissao + frete; entregador pago off-platform).
      const vendor = split.find((r: any) => r.recipient_id === 'rp_vendor_123');
      const platform = split.find((r: any) => r.recipient_id === 'rp_platform_123');
      expect(vendor.amount).toBe(4750);
      expect(platform.amount).toBe(750);
      // Soma tem que fechar com o total (o gateway rejeita se nao fechar).
      expect(split.reduce((s: number, r: any) => s + r.amount, 0)).toBe(5500);
      // A taxa do meio de pagamento sai da parte da LOJA (decisão de
      // 23/10/2026): a plataforma nunca pode receber menos do que paga.
      expect(platform.options.charge_processing_fee).toBe(false);
      expect(vendor.options.charge_processing_fee).toBe(true);
      // RESPONSABILIDADE POR CHARGEBACK: os dois respondem pela propria fatia
      // desde 16/10/2026 (KAN-303). Antes `vendor.liable` era false, e isso
      // significava que num chargeback a plataforma era debitada no valor
      // INTEIRO — inclusive a mercadoria que o vendedor ja tinha recebido.
      expect(platform.options.liable).toBe(true);
      expect(vendor.options.liable).toBe(true);
    });

    it('should split PIX for pickup orders (vendor keeps delivery fee, no deliverer)', async () => {
      const order = makeOrder({ paymentMethod: 'PIX', isPickup: true });
      const customer = makeCustomer();

      httpService.axiosRef.post.mockResolvedValue({ data: pixOrderResponse });

      await service.createOrderPix(order, customer);

      const orderCall = httpService.axiosRef.post.mock.calls.find((c: any) => c[0].includes('/orders'));
      const split = orderCall[1].payments[0].split;
      const vendor = split.find((r: any) => r.recipient_id === 'rp_vendor_123');
      const platform = split.find((r: any) => r.recipient_id === 'rp_platform_123');
      // Retirada: vendedor = 5500 - 250 = 5250; plataforma = 250 (so comissao).
      expect(vendor.amount).toBe(5250);
      expect(platform.amount).toBe(250);
      expect(split.reduce((s: number, r: any) => s + r.amount, 0)).toBe(5500);
    });

    it('should fall back to NO split when vendor has no recipient (sale not blocked)', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        store: makeStore({ owner: makeVendorUser({ pagarmeRecipientId: null }) }),
      });
      const customer = makeCustomer();

      httpService.axiosRef.post.mockResolvedValue({ data: pixOrderResponse });

      const result = await service.createOrderPix(order, customer);

      // Venda nao e bloqueada, mas sem split (dinheiro fica na plataforma).
      expect(result.settledViaSplit).toBe(false);
      const orderCall = httpService.axiosRef.post.mock.calls.find((c: any) => c[0].includes('/orders'));
      expect(orderCall[1].payments[0].split).toBeUndefined();
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

    // C1: PIX split-on-charge — vendedor JA recebeu no pagamento (via split).
    // O settle NAO pode chamar /transfers para o vendedor; o entregador (que nao
    // estava no split da cobranca) vira um payable off-platform.
    it('should NOT transfer to vendor on settle when PIX was split-on-charge, and records deliverer payable', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        isPickup: false,
        settledViaSplit: true,
        delivery: {
          deliverer: { pagarmeRecipientId: 'rp_deliverer_456' },
        },
      });

      httpService.axiosRef.post.mockResolvedValue({ data: { id: 'tr_x', status: 'pending' } });

      await service.settlePayment(order);

      // Nenhuma transferencia (vendedor via split; entregador off-platform).
      const transferCalls = httpService.axiosRef.post.mock.calls.filter(
        (c: any) => c[0].includes('/transfers'),
      );
      expect(transferCalls.length).toBe(0);

      // Payable do entregador registrado nas notes (R$5.00 - 1% = 495 cents).
      const payableUpdate = mockOrderRepo.update.mock.calls.find(
        (c: any) => typeof c[1]?.notes === 'string' && c[1].notes.includes('[DELIVERER_PAYABLE]'),
      );
      expect(payableUpdate).toBeDefined();
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
        pagarmeOrderId: 'or_pix_123',
      });

      httpService.axiosRef.get.mockResolvedValue({
        data: { charges: [{ id: 'ch_abc', status: 'paid' }] },
      });
      httpService.axiosRef.post.mockResolvedValue({
        data: { id: 'tr_1', status: 'pending' },
      });
      // O estorno agora e DELETE /charges/{id}. E a resposta precisa trazer
      // `last_transaction.status`, porque e dali que o service decide se
      // estornou — o provedor responde 200 mesmo quando o estorno falha.
      httpService.axiosRef.delete.mockResolvedValue({
        data: {
          id: 'ch_abc',
          status: 'paid', // parcial: a cobranca SEGUE paid, so parte voltou
          last_transaction: { status: 'partial_refunded', amount: 500 },
        },
      });

      await service.settlePayment(order);

      const refundCall = httpService.axiosRef.delete.mock.calls.find(
        (c: any) => c[0].includes('/charges/ch_abc'),
      );
      expect(refundCall).toBeDefined();
      // No axios o corpo do DELETE vai em config.data
      expect(refundCall[1].data.amount).toBe(500); // 6000 - 5500 centavos
      // Idempotency-Key: um retry de settlement NAO pode estornar em dobro
      expect(refundCall[1].headers['Idempotency-Key']).toBe('weight-refund-order-1');
      // E a rota ANTIGA (v4), que nao existe no provedor, nao pode voltar
      const rotaV4 = httpService.axiosRef.post.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes('/refund'),
      );
      expect(rotaV4).toBeUndefined();
    });

    it('should NOT refund when paid amount equals final total', async () => {
      const order = makeOrder({
        paymentMethod: 'PIX',
        isPickup: true,
        onlinePaidTotal: 55.0, // igual ao total — nada a devolver
        pagarmeOrderId: 'or_pix_123',
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
        pagarmeOrderId: 'or_pix_123',
      });

      httpService.axiosRef.get.mockResolvedValue({
        data: { charges: [{ id: 'ch_abc', status: 'paid' }] },
      });
      httpService.axiosRef.post.mockResolvedValue({ data: { id: 'tr_1', status: 'pending' } });
      // ESTE e o modo de falha REAL do provedor, medido no sandbox: o DELETE
      // responde HTTP 200 e o estorno NAO acontece — a cobranca segue "paid" e a
      // falha aparece so em `last_transaction.status`. Acontece numa janela de
      // poucos segundos apos a captura ("action_forbidden | Valor invalido para
      // estorno"). Antes desta correcao o codigo olhava apenas o status HTTP,
      // entao registraria "estornado" sem ter estornado nada — e este teste
      // passava com um Promise.reject que nao representa o que o provedor faz.
      httpService.axiosRef.delete.mockResolvedValue({
        data: {
          id: 'ch_abc',
          status: 'paid',
          last_transaction: {
            status: 'failed',
            amount: 500,
            gateway_response: {
              code: '400',
              errors: [{ message: 'action_forbidden |  | Valor inválido para estorno.' }],
            },
          },
        },
      });

      await service.settlePayment(order);

      // Claim solto para o retry re-tentar. Seguro porque so chegamos aqui
      // quando o provedor AFIRMOU que falhou — nao ha estorno "talvez feito".
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

    // ─── Regressão auditoria 2026-08-23 ───────────────────────
    // ALTO: settlePayment não pode repassar dinheiro de pedido já cancelado/estornado.
    // O claim de isSettled agora exige status NOT IN (terminais) → 0 linhas → aborta
    // antes de qualquer /transfers (double outflow evitado).
    it('should NOT transfer when the settlement claim finds the order already terminated', async () => {
      const order = makeOrder({ paymentMethod: 'PIX', isPickup: false });
      // claim de settlement (UPDATE isSettled ... AND status NOT IN terminais) → 0 linhas.
      mockOrderRepo.manager.query.mockResolvedValueOnce([]);
      httpService.axiosRef.post.mockResolvedValue({ data: { id: 'tr_x', status: 'pending' } });

      await service.settlePayment(order);

      const transferCalls = httpService.axiosRef.post.mock.calls.filter(
        (c: any) => c[0].includes('/transfers'),
      );
      expect(transferCalls.length).toBe(0);
      // Restaura o mock para os demais testes.
      mockOrderRepo.manager.query.mockResolvedValue([{ id: 'order-1' }]);
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
      httpService.axiosRef.delete.mockResolvedValue({
        data: {
          id: 'ch_late',
          status: 'canceled', // total: a cobranca inteira volta
          last_transaction: { status: 'refunded', amount: 5500 },
        },
      });

      await service.handleWebhook({
        type: 'order.paid',
        data: {
          id: 'or_late',
          charges: [{ id: 'ch_late' }],
          metadata: { order_id: 'order-9' },
        },
      });

      const refundCall = httpService.axiosRef.delete.mock.calls.find(
        (c: any) => c[0].includes('/charges/ch_late'),
      );
      expect(refundCall).toBeDefined();
      // Estorno TOTAL vai SEM corpo — foi a forma validada no sandbox. Mandar
      // `amount` igual ao total nao foi testado contra o provedor, entao nao
      // inventamos.
      expect(refundCall[1].data).toBeUndefined();
      expect(refundCall[1].headers['Idempotency-Key']).toBe('late-refund-order-9');
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

    // ─── Regressão auditoria 2026-08-23 ───────────────────────
    // CRÍTICO: webhook payment_failed/order.canceled TARDIO não pode cancelar
    // um pedido JÁ PAGO (PENDING+). O claim agora exige status='AWAITING_PAYMENT'.
    it('should NOT cancel an already-paid (PENDING) order on a late payment_failed webhook', async () => {
      const paidOrder = {
        id: 'order-late-fail',
        orderNumber: '2001',
        status: OrderStatus.PENDING,
        items: [{ product: { id: 'p1' }, quantity: 1 }],
        customer: { id: 'c1' },
        store: { id: 's1', owner: { id: 'o1' } },
      };
      // O claim condicional (status='AWAITING_PAYMENT') não encontra a linha → 0 linhas.
      const claimQuery = jest.fn().mockResolvedValue([]);
      const orderRepoLocal = {
        findOne: jest.fn().mockResolvedValue(paidOrder),
        save: jest.fn(),
        increment: jest.fn(),
        manager: { query: claimQuery, getRepository: jest.fn(() => ({ increment: jest.fn() })) },
      };
      paymentsRepo.manager.getRepository.mockReturnValue(orderRepoLocal);

      await service.handleWebhook({
        type: 'charge.payment_failed',
        data: { id: 'ch_latefail', metadata: { order_id: 'order-late-fail' } },
      });

      // O claim rodou com o filtro AWAITING_PAYMENT e não afetou nada → pedido intacto.
      const cancelClaim = claimQuery.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes("status = 'AWAITING_PAYMENT'"),
      );
      expect(cancelClaim).toBeDefined();
      expect(orderRepoLocal.save).not.toHaveBeenCalled();
    });

    // ALTO: charge.refunded de um pedido já REJECTED (pelo nosso refundOrder) não
    // pode devolver estoque uma segunda vez — o claim atômico retorna 0 linhas.
    it('should NOT re-restore stock on charge.refunded when order is already terminal', async () => {
      const rejectedOrder = {
        id: 'order-rej',
        orderNumber: '2002',
        status: OrderStatus.REJECTED,
        total: 55.0,
        items: [{ product: { id: 'p1' }, quantity: 3 }],
        customer: { id: 'c1' },
        store: { id: 's1', owner: { id: 'o1' } },
      };
      const productIncrement = jest.fn();
      // claim atômico WITH prev ... RETURNING → 0 linhas (já terminal).
      const claimQuery = jest.fn().mockResolvedValue([]);
      const orderRepoLocal = {
        findOne: jest.fn().mockResolvedValue(rejectedOrder),
        save: jest.fn(),
        manager: {
          query: claimQuery,
          getRepository: jest.fn(() => ({ increment: productIncrement })),
        },
      };
      paymentsRepo.manager.getRepository.mockReturnValue(orderRepoLocal);

      await service.handleWebhook({
        type: 'charge.refunded',
        data: { id: 'ch_ref', status: 'refunded', metadata: { order_id: 'order-rej' }, charges: [] },
      });

      // Nada de restauração de estoque nem save (claim perdeu).
      expect(productIncrement).not.toHaveBeenCalled();
      expect(orderRepoLocal.save).not.toHaveBeenCalled();
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

  // ─── saldo a liberar (waiting funds) ─────────────────────────
  //
  // Guarda do bug confirmado ao vivo em 15/10/2026: o service lia
  // `balance.waiting_funds?.amount` (forma ANINHADA, da v4) em quatro pontos,
  // mas a v5 devolve o campo PLANO `waiting_funds_amount`. Resposta real do
  // sandbox:
  //
  //   { "currency":"BRL", "available_amount":0, "waiting_funds_amount":-99,
  //     "transferred_amount":0, "payment_profile_id":null, "recipient":{...} }
  //
  // Resultado: undefined em todas as leituras, `|| 0` fechava em ZERO, e com
  // isso "Valores a liberar" mostrava R$ 0,00 para todo vendedor e entregador,
  // a simulacao e o pedido de antecipacao desistiam antes de chamar o provedor,
  // e a secao de antecipacao da tela de ganhos (que so aparece com
  // waitingFundsAmount > 0) NUNCA era renderizada.
  //
  // Estes testes batem na forma do payload, que e exatamente o que quebrou.
  describe('getRecipientBalance — forma do payload de saldo', () => {
    function comBalance(balance: any) {
      jest.spyOn(service as any, 'pagarmeGet').mockImplementation((path: any) =>
        String(path).endsWith('/balance')
          ? Promise.resolve(balance)
          : Promise.resolve(null),
      );
    }

    afterEach(() => jest.restoreAllMocks());

    it('le o campo PLANO waiting_funds_amount da v5', async () => {
      comBalance({
        currency: 'BRL',
        available_amount: 12345,
        waiting_funds_amount: 6789,
        transferred_amount: 100,
      });
      const r = await service.getRecipientBalance('re_x');
      expect(r.waitingFundsAmount).toBe(67.89);
      expect(r.availableAmount).toBe(123.45);
      expect(r.transferredAmount).toBe(1);
    });

    it('ainda aceita a forma ANINHADA antiga, para nao zerar em silencio se o provedor variar', async () => {
      comBalance({ available_amount: 0, waiting_funds: { amount: 4200 }, transferred_amount: 0 });
      const r = await service.getRecipientBalance('re_x');
      expect(r.waitingFundsAmount).toBe(42);
    });

    it('zero de verdade quando nenhuma das formas vem', async () => {
      comBalance({ available_amount: 0, transferred_amount: 0 });
      const r = await service.getRecipientBalance('re_x');
      expect(r.waitingFundsAmount).toBe(0);
    });

    it('preserva valor NEGATIVO em vez de virar zero (o sandbox devolve -99)', async () => {
      // Importa porque `|| 0` tambem apagaria um negativo, e saldo negativo e
      // informacao real do provedor — esconder isso mente para o lojista.
      comBalance({ available_amount: 0, waiting_funds_amount: -99, transferred_amount: 0 });
      const r = await service.getRecipientBalance('re_x');
      expect(r.waitingFundsAmount).toBeCloseTo(-0.99, 10);
    });
  });

  // ─── simulacao de antecipacao ────────────────────────────────
  describe('simulateAnticipation — estimativa marcada', () => {
    afterEach(() => jest.restoreAllMocks());

    it('marca isEstimate quando a cotacao do provedor falha (nao finge cotacao)', async () => {
      jest
        .spyOn(service as any, 'pagarmeGet')
        .mockResolvedValue({ waiting_funds_amount: 10000 });
      // o POST da simulacao falha — e o que acontece hoje em toda chamada,
      // porque o caminho /anticipations nao existe na v5
      jest.spyOn(service as any, 'pagarmePost').mockRejectedValue(new Error('404'));

      const r = await service.simulateAnticipation('re_x');
      expect(r.isEstimate).toBe(true);
      expect(r.originalAmount).toBe(100);
      expect(r.feePercentage).toBe(3.5);
    });

    it('nao marca isEstimate quando a cotacao vem do provedor', async () => {
      jest
        .spyOn(service as any, 'pagarmeGet')
        .mockResolvedValue({ waiting_funds_amount: 10000 });
      jest.spyOn(service as any, 'pagarmePost').mockResolvedValue({ amount: 9700 });

      const r = await service.simulateAnticipation('re_x');
      expect(r.isEstimate).toBe(false);
      expect(r.anticipatedAmount).toBe(97);
      expect(r.fee).toBeCloseTo(3, 10);
    });

    it('zero sem saldo a liberar nao e estimativa', async () => {
      jest
        .spyOn(service as any, 'pagarmeGet')
        .mockResolvedValue({ waiting_funds_amount: 0 });
      const r = await service.simulateAnticipation('re_x');
      expect(r.isEstimate).toBe(false);
      expect(r.originalAmount).toBe(0);
    });
  });

  // ─── estorno de cobranca ─────────────────────────────────────
  //
  // Guarda dos dois bugs provados no sandbox em 15/10/2026:
  //
  //  1. a rota `POST /charges/{id}/refund` NAO EXISTE na v5 (404 com corpo
  //     vazio, numa cobranca real e paga). Eram 4 pontos chamando ela, ou seja
  //     todo estorno de cobranca capturada falhava.
  //  2. o `DELETE /charges/{id}` responde HTTP 200 MESMO QUANDO O ESTORNO
  //     FALHA. O resultado real esta em `last_transaction.status`. Quem olhasse
  //     so o status HTTP registraria "estornado" sem ter estornado.
  describe('estornarCobranca', () => {
    const estornar = (chargeId: string, opts?: any) =>
      (service as any).estornarCobranca(chargeId, opts);

    it('estorno TOTAL vai sem corpo (forma validada no provedor)', async () => {
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'canceled', last_transaction: { status: 'refunded', amount: 300 } },
      });
      await estornar('ch_1');
      const [url, config] = httpService.axiosRef.delete.mock.calls.at(-1);
      expect(url).toContain('/charges/ch_1');
      expect(config.data).toBeUndefined();
    });

    it('estorno PARCIAL manda { amount } no corpo do DELETE', async () => {
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'paid', last_transaction: { status: 'partial_refunded', amount: 100 } },
      });
      await estornar('ch_2', { amountCents: 100 });
      const [, config] = httpService.axiosRef.delete.mock.calls.at(-1);
      expect(config.data).toEqual({ amount: 100 });
    });

    it('aceita partial_refunded como sucesso mesmo com a cobranca ainda "paid"', async () => {
      // No parcial a cobranca SEGUE paid — so parte do valor voltou. Tratar
      // "paid" como falha aqui faria o retry estornar de novo.
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'paid', last_transaction: { status: 'partial_refunded', amount: 70 } },
      });
      await expect(estornar('ch_3', { amountCents: 70 })).resolves.toBeUndefined();
    });

    it('LANCA quando o provedor devolve 200 mas last_transaction falhou', async () => {
      httpService.axiosRef.delete.mockResolvedValue({
        data: {
          status: 'paid',
          last_transaction: {
            status: 'failed',
            gateway_response: {
              errors: [{ message: 'action_forbidden |  | Valor inválido para estorno.' }],
            },
          },
        },
      });
      await expect(estornar('ch_4')).rejects.toThrow(/Valor inválido para estorno/);
    });

    it('a mensagem do erro diz se era total ou parcial', async () => {
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'paid', last_transaction: { status: 'failed' } },
      });
      await expect(estornar('ch_5', { amountCents: 250 })).rejects.toThrow(/parcial 250/);
    });

    it('sem last_transaction, o status da cobranca resolve o caso total', async () => {
      httpService.axiosRef.delete.mockResolvedValue({ data: { status: 'canceled' } });
      await expect(estornar('ch_6')).resolves.toBeUndefined();
    });

    it('repassa a Idempotency-Key', async () => {
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'canceled', last_transaction: { status: 'refunded' } },
      });
      await estornar('ch_7', { idempotencyKey: 'chave-x' });
      const [, config] = httpService.axiosRef.delete.mock.calls.at(-1);
      expect(config.headers['Idempotency-Key']).toBe('chave-x');
    });

    // A FORMA QUE O PROVEDOR DEVOLVE NUM VOID DE PRE-AUTORIZACAO.
    //
    // Medida no sandbox em 15/10/2026 e copiada daqui para o mock, para que o
    // teste falhe se alguem apertar a condicao do helper sem saber que o mesmo
    // helper atende dois casos diferentes: estorno de cobranca paga e anulacao
    // de pre-auth nao capturada.
    it('aceita o VOID de pre-auth (canceled + refunded, sem captura nenhuma)', async () => {
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'canceled', last_transaction: { status: 'refunded', amount: 200 } },
      });
      await expect(estornar('ch_preauth')).resolves.toBeUndefined();
    });
  });

  // ─── cancelPreAuth: liberar o limite do cliente ──────────────
  //
  // Este metodo anula a pre-autorizacao quando o pedido cai. Ele usava
  // `pagarmeDelete` cru e descartava a resposta — e nesta rota o provedor
  // responde 200 mesmo recusando. Quem paga por nao olhar e o cliente: o pedido
  // consta cancelado e o limite do cartao segue preso por dias.
  describe('cancelPreAuth — void conferido', () => {
    let erros: string[];
    let avisos: string[];

    beforeEach(() => {
      erros = [];
      avisos = [];
      jest.spyOn((service as any).logger, 'error').mockImplementation((m: any) => { erros.push(String(m)); });
      jest.spyOn((service as any).logger, 'warn').mockImplementation((m: any) => { avisos.push(String(m)); });
      jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
    });

    it('nao chama o provedor quando o pedido nao tem pre-autorizacao', async () => {
      httpService.axiosRef.delete.mockClear();
      await service.cancelPreAuth(makeOrder({ preAuthChargeId: null }) as any);
      expect(httpService.axiosRef.delete).not.toHaveBeenCalled();
    });

    it('anula pela rota DELETE /charges/{id} sem corpo', async () => {
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'canceled', last_transaction: { status: 'refunded' } },
      });
      await service.cancelPreAuth(makeOrder({ preAuthChargeId: 'ch_void_ok' }) as any);
      const [url, config] = httpService.axiosRef.delete.mock.calls.at(-1);
      expect(url).toContain('/charges/ch_void_ok');
      expect(config.data).toBeUndefined();
      expect(erros).toHaveLength(0);
    });

    it('GRITA quando o provedor devolve 200 mas recusa a anulacao', async () => {
      // O caso que passava calado. O pedido ainda cancela (nao lanca), mas o
      // problema vira ERROR com marcador proprio, porque e dinheiro preso.
      httpService.axiosRef.delete.mockResolvedValue({
        data: {
          status: 'paid',
          last_transaction: { status: 'failed', acquirer_message: 'operacao nao permitida' },
        },
      });
      await expect(
        service.cancelPreAuth(makeOrder({ preAuthChargeId: 'ch_void_recusado' }) as any),
      ).resolves.toBeUndefined();
      expect(erros.join(' ')).toContain('[PREAUTH_NAO_LIBERADA]');
      expect(erros.join(' ')).toContain('ch_void_recusado');
      expect(avisos).toHaveLength(0);
    });

    it('segue como AVISO no 412 do provedor (ja anulada ou caducada)', async () => {
      // Medido: anular duas vezes responde 412. E benigno e idempotente — nao
      // deve poluir o monitoramento junto com o caso acima.
      const e: any = new Error('Request failed with status code 412');
      e.response = { status: 412, data: { message: 'charge nao pode ser cancelada' } };
      httpService.axiosRef.delete.mockRejectedValue(e);
      await expect(
        service.cancelPreAuth(makeOrder({ preAuthChargeId: 'ch_412' }) as any),
      ).resolves.toBeUndefined();
      expect(avisos.join(' ')).toContain('may already be expired');
      expect(erros).toHaveLength(0);
    });
  });

  // ─── data de pagamento da antecipacao ────────────────────────
  //
  // A regra e do proprio Pagar.me, lida na mensagem de validacao dele:
  //   "prazo minimo de antecipacao: D+0 ate 11AM ou D+1"
  //
  // O calculo anterior nao tratava o corte das 11h e lia o dia da semana em
  // UTC. Como a API roda TZ=UTC e o negocio e hora de Sao Paulo, isso errava em
  // duas faixas:
  //  - entre 11h e 21h de dia util mandava D+0, que o provedor RECUSA;
  //  - entre 21h e meia-noite a data UTC ja era a de amanha, e o desvio de fim
  //    de semana era calculado sobre o dia errado.
  //
  // Os instantes abaixo sao UTC; o comentario diz a hora de Sao Paulo
  // equivalente (BRT = UTC-3).
  describe('dataDeAntecipacao — regra D+0 ate 11h, senao proximo dia util', () => {
    const data = (iso: string) =>
      (PaymentsService as any).dataDeAntecipacao(new Date(iso));

    it('antes das 11h num dia util: mesmo dia (D+0)', () => {
      expect(data('2026-10-19T12:00:00Z')).toBe('2026-10-19'); // seg 09:00 BRT
      expect(data('2026-10-19T13:59:00Z')).toBe('2026-10-19'); // seg 10:59 BRT
    });

    it('a partir das 11h em ponto: proximo dia (D+1)', () => {
      expect(data('2026-10-19T14:00:00Z')).toBe('2026-10-20'); // seg 11:00 BRT
      expect(data('2026-10-19T17:00:00Z')).toBe('2026-10-20'); // seg 14:00 BRT
    });

    it('entre 21h e meia-noite: usa o dia BRASILEIRO, nao o UTC', () => {
      // 2026-10-20T01:00:00Z e 22:00 de SEGUNDA em Sao Paulo. O calculo antigo
      // via "terca" e partia dali; o certo e partir de segunda e, por ser
      // depois das 11h, cair em terca — o mesmo resultado por outro caminho,
      // mas que deixa de depender de coincidencia.
      expect(data('2026-10-20T01:00:00Z')).toBe('2026-10-20'); // seg 22:00 BRT
    });

    it('sexta depois das 11h pula o fim de semana inteiro', () => {
      expect(data('2026-10-23T17:00:00Z')).toBe('2026-10-26'); // sex 14:00 BRT -> seg
    });

    it('fim de semana cai na segunda, qualquer que seja a hora', () => {
      expect(data('2026-10-24T12:00:00Z')).toBe('2026-10-26'); // sab 09:00 BRT
      expect(data('2026-10-24T20:00:00Z')).toBe('2026-10-26'); // sab 17:00 BRT
      expect(data('2026-10-25T12:00:00Z')).toBe('2026-10-26'); // dom 09:00 BRT
    });

    it('sabado 22h BRT nao escorrega para domingo pelo fuso', () => {
      // 2026-10-25T01:00:00Z e 22:00 de SABADO em Sao Paulo. Em UTC ja e
      // domingo; se o calculo usasse UTC, o desvio partiria de domingo.
      // Qualquer dos dois caminhos tem de terminar na segunda.
      expect(data('2026-10-25T01:00:00Z')).toBe('2026-10-26');
    });

    it('devolve sempre YYYY-MM-DD', () => {
      expect(data('2026-10-19T12:00:00Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  // ─── cancelamento de agendamento: a pre-auth foi mesmo solta? ───────────
  //
  // Este caminho foi alterado em 15/10/2026 (dadf4c4) e nao tinha teste
  // nenhum. Ele mexe em dinheiro: e o que libera o limite do cartao do
  // cliente quando um agendamento e cancelado.
  //
  // O comentario do proprio metodo descreve como BUG o estado que o codigo
  // antigo reproduzia em silencio — "os R$ ficavam bloqueados no limite do
  // cliente ate a pre-autorizacao caducar sozinha, dias depois". Ele usava
  // `pagarmeDelete` cru e descartava a resposta, e o provedor responde 200
  // nessa rota mesmo quando recusa.
  describe('releaseAppointmentPayment', () => {
    let erros: string[];
    let avisos: string[];

    function agendamento(over: any = {}) {
      return {
        id: 'apt-1',
        appointmentNumber: 'AGD-9001',
        preAuthChargeId: 'ch_apt_1',
        capturedAt: null,
        isSettled: false,
        paymentStatus: 'AUTHORIZED',
        pagarmeOrderId: null,
        price: 120,
        ...over,
      } as any;
    }

    beforeEach(() => {
      erros = [];
      avisos = [];
      jest.spyOn((service as any).logger, 'error').mockImplementation((m: any) => { erros.push(String(m)); });
      jest.spyOn((service as any).logger, 'warn').mockImplementation((m: any) => { avisos.push(String(m)); });
      jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
      httpService.axiosRef.delete.mockReset();
      httpService.axiosRef.get.mockReset();
    });

    it('solta a pre-auth pela rota DELETE /charges/{id}, sem corpo', async () => {
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'canceled', last_transaction: { status: 'refunded' } },
      });
      await service.releaseAppointmentPayment(agendamento());
      const [url, config] = httpService.axiosRef.delete.mock.calls.at(-1);
      expect(url).toContain('/charges/ch_apt_1');
      expect(config.data).toBeUndefined();
      expect(erros).toHaveLength(0);
    });

    it('GRITA quando o provedor devolve 200 mas recusa a soltura', async () => {
      // O caso que passava calado, e que devolve o cliente exatamente ao
      // estado que o doc do metodo descreve como bug.
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'paid', last_transaction: { status: 'failed' } },
      });
      await expect(service.releaseAppointmentPayment(agendamento())).resolves.toBeUndefined();
      expect(erros.join(' ')).toContain('[PREAUTH_NAO_LIBERADA]');
      expect(erros.join(' ')).toContain('AGD-9001');
      expect(avisos).toHaveLength(0);
    });

    it('segue como AVISO no 412 (ja caducou ou ja foi solta)', async () => {
      const e: any = new Error('Request failed with status code 412');
      e.response = { status: 412, data: { message: 'charge nao pode ser cancelada' } };
      httpService.axiosRef.delete.mockRejectedValue(e);
      await expect(service.releaseAppointmentPayment(agendamento())).resolves.toBeUndefined();
      expect(avisos.join(' ')).toContain('pode ja ter expirado');
      expect(erros).toHaveLength(0);
    });

    it('NUNCA lanca — o cancelamento nao pode falhar por causa do estorno', async () => {
      // E o que o doc do metodo promete, e o que as duas mutations de
      // cancelamento assumem ao chamar com .catch() por fora.
      httpService.axiosRef.delete.mockRejectedValue(new Error('rede caiu'));
      await expect(service.releaseAppointmentPayment(agendamento())).resolves.toBeUndefined();
    });

    it('ja capturado: nao chama o provedor, e pede acao manual', async () => {
      await service.releaseAppointmentPayment(agendamento({ capturedAt: new Date() }));
      expect(httpService.axiosRef.delete).not.toHaveBeenCalled();
      expect(avisos.join(' ')).toContain('acao manual');
    });

    it('ja liquidado: idem — o dinheiro ja saiu para o prestador', async () => {
      await service.releaseAppointmentPayment(agendamento({ isSettled: true }));
      expect(httpService.axiosRef.delete).not.toHaveBeenCalled();
      expect(avisos.join(' ')).toContain('acao manual');
    });

    it('PIX pago: acha a cobranca paga no pedido e estorna com chave de idempotencia', async () => {
      httpService.axiosRef.get.mockResolvedValue({
        data: {
          charges: [
            { id: 'ch_cancelada', status: 'canceled' },
            { id: 'ch_paga', status: 'paid' },
          ],
        },
      });
      httpService.axiosRef.delete.mockResolvedValue({
        data: { status: 'canceled', last_transaction: { status: 'refunded' } },
      });

      await service.releaseAppointmentPayment(
        agendamento({ preAuthChargeId: null, paymentStatus: 'PAID', pagarmeOrderId: 'or_apt_1' }),
      );

      const [url, config] = httpService.axiosRef.delete.mock.calls.at(-1);
      // Escolhe a cobranca PAGA, nao a primeira da lista.
      expect(url).toContain('/charges/ch_paga');
      // A chave de idempotencia e por AGENDAMENTO: duas tentativas de estorno
      // do mesmo cancelamento nao podem virar dois estornos.
      expect(config.headers['Idempotency-Key']).toBe('appointment-refund-apt-1');
    });

    it('PIX sem cobranca paga no pedido: avisa e nao tenta estornar', async () => {
      httpService.axiosRef.get.mockResolvedValue({
        data: { charges: [{ id: 'ch_x', status: 'pending' }] },
      });
      await service.releaseAppointmentPayment(
        agendamento({ preAuthChargeId: null, paymentStatus: 'PAID', pagarmeOrderId: 'or_apt_2' }),
      );
      expect(httpService.axiosRef.delete).not.toHaveBeenCalled();
      expect(avisos.join(' ')).toContain('nenhuma cobranca paga');
    });

    it('sem pre-auth e sem PIX pago: nao faz nada (nao ha o que soltar)', async () => {
      await service.releaseAppointmentPayment(
        agendamento({ preAuthChargeId: null, paymentStatus: 'PENDING' }),
      );
      expect(httpService.axiosRef.delete).not.toHaveBeenCalled();
      expect(httpService.axiosRef.get).not.toHaveBeenCalled();
      expect(erros).toHaveLength(0);
    });
  });
});
