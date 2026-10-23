import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { Payment } from './entities/payment.entity';
import { SavedCard } from './entities/saved-card.entity';
import { WebhookEvent } from './entities/webhook-event.entity';
import { Subscription } from './entities/subscription.entity';
import { Order } from '../orders/entities/order.entity';
import { Store } from '../stores/entities/store.entity';
import { SubscriptionPlansService } from './subscription-plans.service';
import { AppUsersService } from '../users/app-users.service';
import { VendorUsersService } from '../users/vendor-users.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { percentualEmCentavos, percentualEmReais } from '../common/dinheiro';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MATRIZ DO SPLIT: todo centavo de todo caminho do dinheiro.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Este arquivo existe porque o split é o ponto do sistema onde um erro não
 * aparece. Ele não quebra tela, não lança exceção e não some do log: ele
 * simplesmente paga a pessoa errada, e o Pagar.me executa. Depois de
 * executado não há retroativo — o dinheiro já está na conta de outro.
 *
 * Por isso aqui se verifica o VALOR DE CADA RECEBEDOR, ao centavo, e não que
 * "a chamada foi feita".
 *
 * ─── Como o dinheiro é formado ────────────────────────────────────────────
 *
 *   subtotal   = Σ (promotionalPrice || price) × qtd
 *   comissão   = round((subtotal − desconto) × %plano)   ← NÃO incide no frete
 *   total      = subtotal − desconto + frete
 *
 * ─── Como ele é dividido ──────────────────────────────────────────────────
 *
 * `entregaExterna` = loja SEM frota própria  E  não é retirada  E  frete > 0.
 * É a única situação em que existe entregador a pagar.
 *
 *   PIX (split na cobrança, no momento do pagamento)
 *     vendedor   = entregaExterna ? total − comissão − frete : total − comissão
 *     plataforma = o que sobra
 *     entregador = NÃO ENTRA. No PIX o pagamento é imediato e o entregador só
 *                  é conhecido no READY, depois da divisão. O frete fica com a
 *                  plataforma e vira passivo ([DELIVERER_PAYABLE]).
 *
 *   CARTÃO (captura com split, na confirmação da entrega)
 *     entregador = frete − frete × %comissãoDeEntrega
 *     vendedor   = entregaExterna ? total − comissão − frete : total − comissão
 *     plataforma = o que sobra
 *
 * A plataforma SEMPRE leva o resíduo. Não é descuido: é o que faz a soma
 * fechar com o total em qualquer arredondamento, e é quem absorve o MDR.
 *
 * ─── O que cada caso aqui protege ─────────────────────────────────────────
 *
 * A invariante que vale para TODOS: a soma das regras é exatamente o total.
 * Se ela quebrar, o gateway recusa a cobrança — e num pedido já entregue isso
 * significa a plataforma não receber nada.
 *
 * Os casos de comissão 0% (PREMIUM/ENTERPRISE) existem porque já houve bug
 * ali: com o vendedor levando 100%, a fatia da plataforma dava 0, a regra
 * dela não era adicionada, e o split saía sem ninguém marcado como `liable`
 * nem pagando a taxa da adquirente.
 */
describe('MATRIZ DO SPLIT — vendedor, entregador e marketplace', () => {
  let service: PaymentsService;
  let http: any;

  const RECEBEDOR_VENDEDOR = 'rp_vendedor';
  const RECEBEDOR_ENTREGADOR = 'rp_entregador';
  const RECEBEDOR_PLATAFORMA = 'rp_plataforma';

  /** % da taxa de entrega que a plataforma retém do entregador. */
  const COMISSAO_DE_ENTREGA = 10;

  beforeEach(async () => {
    http = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({
          data: {
            id: 'or_1',
            status: 'paid',
            charges: [{ id: 'ch_1', status: 'paid', last_transaction: { qr_code: 'qr' } }],
          },
        }),
        get: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
      },
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: repoSimples() },
        { provide: getRepositoryToken(Store), useValue: repoSimples() },
        { provide: getRepositoryToken(SavedCard), useValue: repoSimples() },
        { provide: getRepositoryToken(WebhookEvent), useValue: repoSimples() },
        { provide: getRepositoryToken(Subscription), useValue: repoSimples() },
        { provide: SubscriptionPlansService, useValue: {} },
        { provide: PUB_SUB, useValue: { publish: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              k === 'PAGARME_PLATFORM_RECIPIENT_ID' ? RECEBEDOR_PLATAFORMA : 'x',
          },
        },
        { provide: HttpService, useValue: http },
        { provide: AppUsersService, useValue: {} },
        { provide: VendorUsersService, useValue: {} },
        {
          provide: PlatformConfigService,
          useValue: {
            getDeliveryCommissionPercent: jest.fn().mockResolvedValue(COMISSAO_DE_ENTREGA),
          },
        },
        { provide: WhatsAppService, useValue: { sendText: jest.fn() } },
        { provide: NotificationsService, useValue: { sendToVendorUser: jest.fn(), sendToAppUser: jest.fn() } },
      ],
    }).compile();

    service = mod.get<PaymentsService>(PaymentsService);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  });

  function repoSimples() {
    return {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((x: any) => Promise.resolve(x)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn().mockImplementation((x: any) => x),
      manager: {
        getRepository: () => ({ update: jest.fn().mockResolvedValue({ affected: 1 }) }),
        query: jest.fn().mockResolvedValue([[{ id: 'x' }], 1]),
      },
    } as any;
  }

  // ─── o pedido, montado a partir das regras de negócio ───────────────────
  //
  // Monto subtotal/comissão/total pela MESMA fórmula do createOrder em vez de
  // escrever números prontos. Assim o caso de teste descreve a SITUAÇÃO
  // (plano, frete, cupom, promoção) e não um resultado decorado — se a
  // fórmula do pedido mudar, o teste acompanha, e o que ele trava é a
  // DIVISÃO, que é o que este arquivo existe para proteger.
  interface Cenario {
    nome: string;
    precoUnitario: number;
    quantidade?: number;
    /** Preço de propaganda. Quando existe, substitui o preço normal. */
    precoPromocional?: number;
    desconto?: number;
    frete?: number;
    comissaoPercent: number;
    entregaPropria?: boolean;
    retirada?: boolean;
    /** Entregador sem recebedor no Pagar.me: a parte dele fica com a plataforma. */
    entregadorSemRecebedor?: boolean;
  }

  function montar(c: Cenario) {
    const qtd = c.quantidade ?? 1;
    const unitario = c.precoPromocional ?? c.precoUnitario;
    const subtotal = unitario * qtd;
    const desconto = c.desconto ?? 0;
    const frete = c.frete ?? 0;
    const comissao = percentualEmReais(subtotal - desconto, c.comissaoPercent);
    const total = subtotal - desconto + frete;

    const order: any = {
      id: 'order-1',
      orderNumber: '1001',
      subtotal,
      discount: desconto,
      deliveryFee: frete,
      total,
      commissionAmount: comissao,
      isPickup: !!c.retirada,
      preAuthChargeId: 'ch_preauth',
      notes: '',
      store: {
        id: 'store-1',
        hasOwnDelivery: !!c.entregaPropria,
        owner: { id: 'v1', pagarmeRecipientId: RECEBEDOR_VENDEDOR },
      },
      customer: { id: 'c1', name: 'Cliente', email: 'c@t.com', cpf: '12345678901', phone: '5399' },
      items: [{ product: { name: 'Produto' }, quantity: qtd, weightGrams: 0 }],
      delivery: c.retirada
        ? null
        : {
            id: 'd1',
            deliverer: {
              id: 'e1',
              pagarmeRecipientId: c.entregadorSemRecebedor ? null : RECEBEDOR_ENTREGADOR,
            },
          },
    };
    return { order, centavos: Math.round(total * 100) };
  }

  /** O split que o código MANDOU, por recebedor, em centavos. */
  function splitEnviado(chamada: any[]): Record<string, number> {
    const regras: any[] = chamada[1]?.split || chamada[1]?.payments?.[0]?.split || [];
    const porRecebedor: Record<string, number> = {};
    for (const r of regras) porRecebedor[r.recipient_id] = (porRecebedor[r.recipient_id] || 0) + r.amount;
    return porRecebedor;
  }

  function regras(chamada: any[]): any[] {
    return chamada[1]?.split || chamada[1]?.payments?.[0]?.split || [];
  }

  async function splitDoPix(c: Cenario) {
    const { order, centavos } = montar(c);
    http.axiosRef.post.mockClear();
    await service.createOrderPix(order, order.customer);
    const chamada = http.axiosRef.post.mock.calls.find((x: any) => String(x[0]).includes('/orders'));
    return { porRecebedor: splitEnviado(chamada), regras: regras(chamada), totalCents: centavos };
  }

  async function splitDoCartao(c: Cenario) {
    const { order, centavos } = montar(c);
    http.axiosRef.post.mockClear();
    await service.captureWithSplit(order);
    const chamada = http.axiosRef.post.mock.calls.find((x: any) => String(x[0]).includes('/capture'));
    return { porRecebedor: splitEnviado(chamada), regras: regras(chamada), totalCents: centavos };
  }

  /**
   * As invariantes que valem em TODOS os casos.
   *
   * SOMA: se não fecha com o total, o gateway recusa a cobrança — e num pedido
   * já entregue isso quer dizer que a plataforma não recebe nada.
   *
   * TAXA DA ADQUIRENTE: exatamente um pagador. Sem ninguém, o gateway recusa;
   * com dois, alguém paga MDR duas vezes.
   *
   * RESPONSABILIDADE (`liable`): mudou em 16/10/2026, com o KAN-303. Antes era
   * "exatamente um" — só a plataforma — e isso significava que num chargeback
   * ela era debitada no valor INTEIRO, inclusive a mercadoria que o vendedor
   * já havia recebido e entregue. Recuperar repasse feito é impossível na v5,
   * então a plataforma absorvia e pronto.
   *
   * Agora o VENDEDOR responde pela fatia dele e a PLATAFORMA pela dela, e o
   * ENTREGADOR não responde por nada — ele fez a corrida, e um frete de R$ 9
   * não pode virar um débito de R$ 110 numa disputa que ele não tem como
   * contestar. Por isso a asserção é sobre QUEM responde, não sobre quantos:
   * contar daria o mesmo número num split em que o entregador respondesse no
   * lugar do vendedor.
   */
  function conferirInvariantes(r: { porRecebedor: Record<string, number>; regras: any[]; totalCents: number }) {
    const soma = Object.values(r.porRecebedor).reduce((s, v) => s + v, 0);
    expect(soma).toBe(r.totalCents);
    expect(r.regras.every((x) => x.amount > 0)).toBe(true);
    expect(r.regras.filter((x) => x.options?.charge_processing_fee).length).toBe(1);
    // Quem paga a taxa é a LOJA, nunca a plataforma nem o entregador — a
    // plataforma não pode receber menos do que paga (decisão de 23/10/2026).
    const pagador = r.regras.find((x) => x.options?.charge_processing_fee);
    if (r.porRecebedor[RECEBEDOR_VENDEDOR]) expect(pagador.recipient_id).toBe(RECEBEDOR_VENDEDOR);
    expect(pagador.recipient_id).not.toBe(RECEBEDOR_ENTREGADOR);

    const responsaveis = r.regras.filter((x) => x.options?.liable).map((x) => x.recipient_id);
    expect(responsaveis.length).toBeGreaterThan(0);
    expect(responsaveis).not.toContain(RECEBEDOR_ENTREGADOR);
    // Toda regra que não é do entregador responde pela própria fatia.
    const naoEntregador = r.regras
      .filter((x) => x.recipient_id !== RECEBEDOR_ENTREGADOR)
      .map((x) => x.recipient_id);
    for (const id of naoEntregador) expect(responsaveis).toContain(id);
  }

  // ════════════════════════════════════════════════════════════════════════
  // PIX — split na cobrança. O entregador NUNCA entra.
  // ════════════════════════════════════════════════════════════════════════
  describe('PIX, entrega pelo app (loja sem frota)', () => {
    // R$ 100 + R$ 10 de frete, plano FREE 5%.
    // comissão = 5% de 100 = 5,00
    // vendedor = 110 − 5 − 10 = 95,00
    // plataforma = 110 − 95 = 15,00  (comissão 5 + frete 10 retido)
    const cenario: Cenario = { nome: 'free', precoUnitario: 100, frete: 10, comissaoPercent: 5 };

    it('vendedor recebe total − comissão − frete', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(9500);
    });

    it('plataforma retém comissão + frete (o frete vira passivo do entregador)', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(1500);
    });

    it('o ENTREGADOR não aparece no split — ele ainda não é conhecido', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_ENTREGADOR]).toBeUndefined();
    });

    it('a soma fecha com o total', async () => {
      conferirInvariantes(await splitDoPix(cenario));
    });
  });

  describe('PIX, retirada na loja', () => {
    // Sem frete: o vendedor fica com tudo menos a comissão.
    const cenario: Cenario = { nome: 'retirada', precoUnitario: 100, frete: 0, comissaoPercent: 5, retirada: true };

    it('vendedor recebe total − comissão', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(9500);
    });

    it('plataforma recebe só a comissão', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(500);
    });

    it('a soma fecha com o total', async () => {
      conferirInvariantes(await splitDoPix(cenario));
    });
  });

  describe('PIX, loja com FROTA PRÓPRIA (cobra frete e fica com ele)', () => {
    // A loja entrega e cobra R$ 10. Como não há entregador do app, o frete é
    // dela: vendedor = total − comissão, e a comissão NÃO incide sobre o frete.
    const cenario: Cenario = { nome: 'frota', precoUnitario: 100, frete: 10, comissaoPercent: 5, entregaPropria: true };

    it('vendedor fica com o frete (total − comissão)', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(10500);
    });

    it('plataforma recebe só a comissão sobre a mercadoria', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(500);
    });

    it('a soma fecha com o total', async () => {
      conferirInvariantes(await splitDoPix(cenario));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // CARTÃO — captura com split. É o único caminho em que o entregador recebe
  // automaticamente, porque na captura ele já é conhecido.
  // ════════════════════════════════════════════════════════════════════════
  describe('CARTÃO, entrega pelo app — os TRÊS recebem', () => {
    // R$ 100 + R$ 10 de frete, FREE 5%, comissão de entrega 10%.
    // comissão      = 5,00
    // entregador    = 10 − 10% = 9,00
    // vendedor      = 110 − 5 − 10 = 95,00
    // plataforma    = 110 − 9 − 95 = 6,00  (comissão 5 + 1 da entrega)
    const cenario: Cenario = { nome: 'cartao', precoUnitario: 100, frete: 10, comissaoPercent: 5 };

    it('entregador recebe o frete menos a comissão de entrega', async () => {
      const r = await splitDoCartao(cenario);
      expect(r.porRecebedor[RECEBEDOR_ENTREGADOR]).toBe(900);
    });

    it('vendedor recebe total − comissão − frete', async () => {
      const r = await splitDoCartao(cenario);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(9500);
    });

    it('plataforma recebe comissão + comissão de entrega', async () => {
      const r = await splitDoCartao(cenario);
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(600);
    });

    it('a soma dos TRÊS fecha com o total', async () => {
      conferirInvariantes(await splitDoCartao(cenario));
    });
  });

  describe('CARTÃO, entregador SEM recebedor no Pagar.me', () => {
    // A parte dele fica com a plataforma. É uma perda real para o entregador
    // de uma entrega já feita, e o split não tem retroativo — por isso o
    // pedido é marcado [DELIVERER_UNPAID] para a dívida ficar rastreável.
    const cenario: Cenario = {
      nome: 'sem recebedor', precoUnitario: 100, frete: 10, comissaoPercent: 5,
      entregadorSemRecebedor: true,
    };

    it('ninguém recebe no lugar dele — a parte vai para a plataforma', async () => {
      const r = await splitDoCartao(cenario);
      expect(r.porRecebedor[RECEBEDOR_ENTREGADOR]).toBeUndefined();
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(9500);
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(1500);
    });

    it('a soma continua fechando com o total', async () => {
      conferirInvariantes(await splitDoCartao(cenario));
    });
  });

  describe('CARTÃO, retirada na loja (não há entregador)', () => {
    const cenario: Cenario = { nome: 'retirada cartao', precoUnitario: 100, frete: 0, comissaoPercent: 5, retirada: true };

    it('só vendedor e plataforma', async () => {
      const r = await splitDoCartao(cenario);
      expect(r.porRecebedor[RECEBEDOR_ENTREGADOR]).toBeUndefined();
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(9500);
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(500);
    });

    it('a soma fecha com o total', async () => {
      conferirInvariantes(await splitDoCartao(cenario));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // OS PLANOS — a comissão é a receita real da plataforma.
  // ════════════════════════════════════════════════════════════════════════
  describe('comissão por plano, no mesmo pedido de R$ 100 + R$ 10', () => {
    const base = { precoUnitario: 100, frete: 10 };

    it('FREE 5%: plataforma 15,00 (5 de comissão + 10 de frete retido)', async () => {
      const r = await splitDoPix({ nome: 'free', ...base, comissaoPercent: 5 });
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(1500);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(9500);
    });

    it('PRO 2%: plataforma 12,00, vendedor 98,00', async () => {
      const r = await splitDoPix({ nome: 'pro', ...base, comissaoPercent: 2 });
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(1200);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(9800);
    });

    it('PREMIUM 0%: plataforma fica só com o frete retido', async () => {
      const r = await splitDoPix({ nome: 'premium', ...base, comissaoPercent: 0 });
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(1000);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(10000);
    });

    it.each([5, 2, 0])('a soma fecha com %i%% de comissão', async (pct) => {
      conferirInvariantes(await splitDoPix({ nome: 'p', ...base, comissaoPercent: pct }));
    });
  });

  describe('comissão 0% SEM frete — o caso que já quebrou o split', () => {
    // PREMIUM em retirada: o vendedor leva 100% e a fatia da plataforma dá 0.
    // A regra dela não pode ser adicionada com valor zero (o gateway recusa),
    // então a responsabilidade e a taxa passam para a regra do vendedor. Sem
    // isso, o split sai sem ninguém `liable`: ou o gateway recusa a cobrança
    // de um pedido já entregue, ou a plataforma paga o MDR do próprio bolso.
    const cenario: Cenario = { nome: 'premium retirada', precoUnitario: 100, frete: 0, comissaoPercent: 0, retirada: true };

    it('o vendedor recebe 100% do total', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(10000);
    });

    it('NÃO existe regra de valor zero para a plataforma', async () => {
      const r = await splitDoPix(cenario);
      expect(r.regras.every((x) => x.amount > 0)).toBe(true);
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBeUndefined();
    });

    it('e alguém continua sendo o responsável, pagando a taxa', async () => {
      // Aqui a regra da plataforma não existe (ela ficaria com zero), então
      // quem herda a taxa E a responsabilidade é o vendedor — que fica com
      // 100%. É o unico caso em que uma regra acumula as duas coisas.
      const r = await splitDoPix(cenario);
      const unica = r.regras[0];
      expect(r.regras).toHaveLength(1);
      expect(unica.recipient_id).toBe(RECEBEDOR_VENDEDOR);
      expect(unica.options.liable).toBe(true);
      expect(unica.options.charge_processing_fee).toBe(true);
      conferirInvariantes(r);
    });

    it('o mesmo vale no CARTÃO', async () => {
      const r = await splitDoCartao(cenario);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(10000);
      conferirInvariantes(r);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // PROPAGANDA — a promoção troca o preço unitário, então muda TODO o resto.
  // ════════════════════════════════════════════════════════════════════════
  describe('produto em PROPAGANDA (preço promocional)', () => {
    // De R$ 100 para R$ 80. A comissão incide sobre o preço VENDIDO, não
    // sobre o de tabela: 5% de 80 = 4,00.
    // vendedor   = 90 − 4 − 10 = 76,00
    // plataforma = 90 − 76 = 14,00
    const cenario: Cenario = {
      nome: 'promo', precoUnitario: 100, precoPromocional: 80, frete: 10, comissaoPercent: 5,
    };

    it('a comissão incide sobre o preço PROMOCIONAL, não sobre o de tabela', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(7600);
      expect(r.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(1400);
    });

    it('a soma fecha com o total promocional', async () => {
      const r = await splitDoPix(cenario);
      expect(r.totalCents).toBe(9000);
      conferirInvariantes(r);
    });

    it('no CARTÃO o entregador recebe o mesmo — o frete não é afetado pela promoção', async () => {
      const r = await splitDoCartao(cenario);
      expect(r.porRecebedor[RECEBEDOR_ENTREGADOR]).toBe(900);
      conferirInvariantes(r);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // CUPOM — desconto reduz a base da comissão, e quem paga o desconto é o
  // VENDEDOR (sai da parte dele), não a plataforma.
  // ════════════════════════════════════════════════════════════════════════
  describe('pedido com CUPOM de desconto', () => {
    // R$ 100 − R$ 20 de cupom + R$ 10 de frete = R$ 90.
    // comissão = 5% de (100 − 20) = 4,00
    // vendedor = 90 − 4 − 10 = 76,00
    const cenario: Cenario = { nome: 'cupom', precoUnitario: 100, desconto: 20, frete: 10, comissaoPercent: 5 };

    it('a comissão incide sobre o valor JÁ COM desconto', async () => {
      const r = await splitDoPix(cenario);
      expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(7600);
    });

    it('o desconto sai da parte do vendedor, não da plataforma', async () => {
      // Sem cupom a plataforma levaria 15,00; com cupom leva 14,00 — cai só o
      // 1,00 de comissão que o desconto tirou da base. O resto do desconto
      // (19,00) saiu inteiro do vendedor.
      const comCupom = await splitDoPix(cenario);
      const semCupom = await splitDoPix({ ...cenario, desconto: 0 });
      expect(semCupom.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(1500);
      expect(comCupom.porRecebedor[RECEBEDOR_PLATAFORMA]).toBe(1400);
      expect(semCupom.porRecebedor[RECEBEDOR_VENDEDOR] - comCupom.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(1900);
    });

    it('a soma fecha com o total já descontado', async () => {
      const r = await splitDoPix(cenario);
      expect(r.totalCents).toBe(9000);
      conferirInvariantes(r);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // A EQUIVALÊNCIA ENTRE OS DOIS MEIOS DE PAGAMENTO.
  //
  // Esta é a invariante mais fácil de quebrar sem perceber, porque os dois
  // caminhos vivem em funções diferentes e parecem independentes.
  //
  // No CARTÃO o entregador entra no split e recebe na hora.
  // No PIX ele não entra; a plataforma segura o frete e fica devendo.
  //
  // O que NÃO pode mudar é o resultado econômico: depois de pagar o
  // entregador, a plataforma tem de ficar com o MESMO valor nos dois. Se
  // ficar com mais no PIX, está comendo o frete do entregador; se ficar com
  // menos, está pagando do próprio bolso por escolher PIX.
  //
  // O passivo do PIX usa `frete − frete × %comissãoDeEntrega`, a mesma
  // fórmula da fatia do entregador no cartão — é isso que faz as contas
  // baterem, e é exatamente isso que estes testes travam.
  // ════════════════════════════════════════════════════════════════════════
  describe('PIX e CARTÃO deixam a plataforma com o MESMO líquido', () => {
    /** O que o PIX vira passivo do entregador: a mesma fórmula do split do cartão. */
    const passivoDoEntregador = (freteReais: number) => {
      const frete = Math.round(freteReais * 100);
      return frete - Math.round(frete * (COMISSAO_DE_ENTREGA / 100));
    };

    it.each([
      ['FREE 5%', 100, 10, 5],
      ['PRO 2%', 100, 10, 2],
      ['PREMIUM 0%', 100, 10, 0],
      ['frete alto', 50, 25, 5],
      ['valores quebrados', 33.33, 7.77, 5],
    ])('%s: plataforma fica igual nos dois meios', async (_nome, preco, frete, pct) => {
      const cenario: Cenario = { nome: 'eq', precoUnitario: preco, frete, comissaoPercent: pct };

      const pix = await splitDoPix(cenario);
      const cartao = await splitDoCartao(cenario);

      const liquidoNoPix =
        pix.porRecebedor[RECEBEDOR_PLATAFORMA] - passivoDoEntregador(frete);
      const liquidoNoCartao = cartao.porRecebedor[RECEBEDOR_PLATAFORMA];

      expect(liquidoNoPix).toBe(liquidoNoCartao);
    });

    it.each([
      ['FREE 5%', 100, 10, 5],
      ['PRO 2%', 100, 10, 2],
      ['valores quebrados', 33.33, 7.77, 5],
    ])('%s: e o VENDEDOR recebe exatamente o mesmo nos dois', async (_n, preco, frete, pct) => {
      const cenario: Cenario = { nome: 'eq', precoUnitario: preco, frete, comissaoPercent: pct };
      const pix = await splitDoPix(cenario);
      const cartao = await splitDoCartao(cenario);
      expect(pix.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(cartao.porRecebedor[RECEBEDOR_VENDEDOR]);
    });

    it('e o entregador recebe o mesmo valor, só que em momentos diferentes', async () => {
      const cenario: Cenario = { nome: 'eq', precoUnitario: 100, frete: 10, comissaoPercent: 5 };
      const cartao = await splitDoCartao(cenario);
      // No cartão: direto no split. No PIX: como passivo, depois.
      expect(cartao.porRecebedor[RECEBEDOR_ENTREGADOR]).toBe(passivoDoEntregador(10));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // ARREDONDAMENTO — onde o centavo perdido aparece.
  // ════════════════════════════════════════════════════════════════════════
  describe('arredondamento: o centavo tem de ir para alguém', () => {
    // 5% de 33,33 = 1,6665 → a comissão arredonda. O resíduo da plataforma
    // absorve a diferença, e é por isso que a soma fecha mesmo assim.
    const cenario: Cenario = { nome: 'quebrado', precoUnitario: 33.33, frete: 7.77, comissaoPercent: 5 };

    it('a soma continua exata, ao centavo', async () => {
      const r = await splitDoPix(cenario);
      expect(r.totalCents).toBe(4110);
      conferirInvariantes(r);
    });

    it('no cartão, com três regras, também fecha', async () => {
      const r = await splitDoCartao(cenario);
      expect(r.totalCents).toBe(4110);
      conferirInvariantes(r);
    });

    it.each([
      [0.01, 0],
      [9.99, 0.01],
      [19.99, 4.99],
      [1234.56, 78.9],
    ])('preço %s com frete %s fecha a soma', async (preco, frete) => {
      conferirInvariantes(await splitDoCartao({ nome: 'v', precoUnitario: preco, frete, comissaoPercent: 5 }));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // VARREDURA — todas as combinações, valor exato de cada recebedor.
  //
  // Os blocos acima descrevem situações; este cruza tudo com tudo (meio de
  // pagamento × modo de entrega × plano × preço × quantidade × cupom × frete)
  // e confere, além das invariantes, o VALOR de cada um pela regra escrita no
  // topo deste arquivo. Os preços incluem os de meio centavo de comissão
  // (2,90 / 20,10 / 37,90), onde a conta em float errava.
  // ════════════════════════════════════════════════════════════════════════
  describe('varredura de combinações', () => {
    const precos = [0.5, 2.9, 7.25, 20.1, 37.9, 99.99, 250];
    const quantidades = [1, 3];
    const fretes = [0.98, 1.09, 7.77];
    const planos = [5, 2, 0];
    const cupons = [0, 1.5];
    const modos = [
      { nome: 'entregador do app', entregaPropria: false, retirada: false },
      { nome: 'frota própria', entregaPropria: true, retirada: false },
      { nome: 'retirada', entregaPropria: false, retirada: true },
    ];

    const casos: Array<[string, Cenario]> = [];
    for (const preco of precos)
      for (const quantidade of quantidades)
        for (const pct of planos)
          for (const desconto of cupons)
            for (const modo of modos)
              for (const frete of modo.retirada ? [0] : fretes) {
                if (desconto >= preco * quantidade) continue;
                casos.push([
                  `${modo.nome} | ${quantidade}x R$${preco} | ${pct}% | cupom ${desconto} | frete ${frete}`,
                  { nome: 'v', precoUnitario: preco, quantidade, frete, desconto, comissaoPercent: pct, entregaPropria: modo.entregaPropria, retirada: modo.retirada },
                ]);
              }

    function esperado(c: Cenario) {
      const { order, centavos } = montar(c);
      const comissao = Math.round(order.commissionAmount * 100);
      const frete = Math.round(order.deliveryFee * 100);
      const externa = !c.entregaPropria && !c.retirada && frete > 0;
      const vendedor = externa ? centavos - comissao - frete : centavos - comissao;
      const entregador = externa ? frete - percentualEmCentavos(frete, COMISSAO_DE_ENTREGA) : 0;
      return { vendedor, entregador };
    }

    it(`${casos.length} combinações no PIX: soma, regras e valor de cada um`, async () => {
      for (const [nome, c] of casos) {
        const r = await splitDoPix(c);
        const e = esperado(c);
        try {
          conferirInvariantes(r);
          expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(e.vendedor);
          expect(r.porRecebedor[RECEBEDOR_ENTREGADOR]).toBeUndefined();
        } catch (err: any) {
          throw new Error(`PIX ${nome}: ${err.message}`);
        }
      }
    });

    it(`${casos.length} combinações no CARTÃO: soma, regras e valor de cada um`, async () => {
      for (const [nome, c] of casos) {
        const r = await splitDoCartao(c);
        const e = esperado(c);
        try {
          conferirInvariantes(r);
          expect(r.porRecebedor[RECEBEDOR_VENDEDOR]).toBe(e.vendedor);
          expect(r.porRecebedor[RECEBEDOR_ENTREGADOR] ?? 0).toBe(e.entregador);
        } catch (err: any) {
          throw new Error(`CARTÃO ${nome}: ${err.message}`);
        }
      }
    });
  });
});
