import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { PagarmePlan } from './entities/pagarme-plan.entity';
import { VendorPlan } from '../common/enums';
import { PlatformConfigService } from '../config/platform-config.service';
import { PLAN_CONFIGS } from '../common/plan-config';

const BILLING_PERIODS = [
  { key: 'monthly', intervalCount: 1, installments: 1 },
  { key: 'quarterly', intervalCount: 3, installments: 3 },
  { key: 'semiannual', intervalCount: 6, installments: 6 },
  { key: 'annual', intervalCount: 12, installments: 12 },
] as const;

const PAID_PLANS = [VendorPlan.PRO, VendorPlan.PREMIUM, VendorPlan.ENTERPRISE];

function getPriceKey(period: string): 'monthlyPrice' | 'quarterlyPrice' | 'semiannualPrice' | 'annualPrice' {
  switch (period) {
    case 'quarterly': return 'quarterlyPrice';
    case 'semiannual': return 'semiannualPrice';
    case 'annual': return 'annualPrice';
    default: return 'monthlyPrice';
  }
}

@Injectable()
export class SubscriptionPlansService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionPlansService.name);
  private readonly pagarmeBaseUrl = 'https://api.pagar.me/core/v5';
  private readonly pagarmeAuthHeader: string;

  constructor(
    @InjectRepository(PagarmePlan)
    private plansRepository: Repository<PagarmePlan>,
    private configService: ConfigService,
    private httpService: HttpService,
    private platformConfigService: PlatformConfigService,
  ) {
    const secretKey = this.configService.get('PAGARME_SECRET_KEY') || '';
    this.pagarmeAuthHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');
  }

  async onModuleInit() {
    try {
      await this.syncPlans();
    } catch (err) {
      this.logger.error('Failed to sync Pagar.me plans', err.message);
    }
  }

  /**
   * BUGFIX (3.7): lia o PLAN_CONFIGS estatico (common/plan-config.ts), enquanto
   * TODO o resto do sistema usa a config editavel do superadmin
   * (platform-config.service). Como o plano do Pagar.me criado aqui e o que de
   * fato COBRA a assinatura recorrente, e `if (existing) continue` nunca
   * re-sincronizava, subir o preco do PRO no painel fazia o vendedor ver e
   * aceitar R$ 59,90 enquanto o cartao seguia sendo cobrado R$ 49,90 para
   * sempre — vazamento de receita silencioso em cada ciclo (e cobranca a MAIOR
   * se o preco fosse reduzido).
   *
   * Agora: alem de criar os planos que faltam, ALINHA o preco do plano no
   * Pagar.me com a config quando divergirem. No Pagar.me v5, editar um plano so
   * afeta assinaturas NOVAS (as vivas copiam os items na criacao e congelam o
   * valor) — entao isso fecha a divergencia do checkout sem mexer na cobranca
   * de quem ja assinou. A migracao das assinaturas ativas continua sendo
   * decisao operacional (fica so o warn).
   *
   * Roda no boot e apos cada updatePlanConfig do superadmin (via resolver).
   */
  async syncPlans(onlyPlan?: VendorPlan): Promise<void> {
    for (const plan of PAID_PLANS) {
      if (onlyPlan && plan !== onlyPlan) continue;
      const config = await this.platformConfigService.getPlanConfig(plan);
      for (const period of BILLING_PERIODS) {
        // um periodo que falhar nao pode bloquear os demais
        try {
          await this.ensurePlanForPeriod(plan, period, config);
        } catch (err) {
          this.logger.error(
            `Falha ao sincronizar plano ${plan}_${period.key.toUpperCase()}: ` +
              `${err.response?.data?.message || err.message}`,
          );
        }
      }
    }
  }

  private async ensurePlanForPeriod(
    plan: VendorPlan,
    period: (typeof BILLING_PERIODS)[number],
    config: Awaited<ReturnType<PlatformConfigService['getPlanConfig']>>,
  ): Promise<void> {
    const planName = `${plan}_${period.key.toUpperCase()}`;
    const existing = await this.plansRepository.findOne({
      where: { vendorPlan: plan, billingPeriod: period.key },
    });

    const priceInCents = Math.round(config[getPriceKey(period.key)] * 100);

    if (existing) {
      if (priceInCents > 0 && existing.priceInCents !== priceInCents) {
        await this.updatePagarmePlanPrice(existing.pagarmePlanId, priceInCents, planName);
        const precoAntigo = existing.priceInCents;
        existing.priceInCents = priceInCents;
        await this.plansRepository.save(existing);
        this.logger.warn(
          `Plano ${planName}: preco atualizado no Pagar.me de ${precoAntigo} para ${priceInCents} ` +
            `centavos. Vale para assinaturas NOVAS; as ATIVAS seguem no valor antigo ate serem migradas.`,
        );
      }
      return;
    }

    if (priceInCents <= 0) return;

    const installmentsArray = Array.from(
      { length: period.installments },
      (_, i) => i + 1,
    );

    const pagarmeResult = await this.createPagarmePlan({
      name: planName,
      intervalCount: period.intervalCount,
      priceInCents,
      installments: installmentsArray,
    });

    const localPlan = this.plansRepository.create({
      pagarmePlanId: pagarmeResult.id,
      vendorPlan: plan,
      billingPeriod: period.key,
      intervalCount: period.intervalCount,
      priceInCents,
      installments: period.installments,
    });
    await this.plansRepository.save(localPlan);

    this.logger.log(`Created Pagar.me plan ${planName}: ${pagarmeResult.id}`);
  }

  /**
   * O preco de um plano v5 mora no ITEM do plano, nao no plano em si —
   * PUT /plans/:id nao aceita pricing_scheme. Busca o item e atualiza.
   */
  private async updatePagarmePlanPrice(
    pagarmePlanId: string,
    priceInCents: number,
    planName: string,
  ): Promise<void> {
    const headers = {
      Authorization: this.pagarmeAuthHeader,
      'Content-Type': 'application/json',
    };
    const { data: remotePlan } = await this.httpService.axiosRef.get(
      `${this.pagarmeBaseUrl}/plans/${pagarmePlanId}`,
      { headers },
    );
    const item = remotePlan?.items?.[0];
    if (!item?.id) {
      throw new Error(`Plano ${planName} (${pagarmePlanId}) sem item no Pagar.me`);
    }
    await this.httpService.axiosRef.put(
      `${this.pagarmeBaseUrl}/plans/${pagarmePlanId}/items/${item.id}`,
      {
        name: item.name || `Plano ${planName}`,
        quantity: 1,
        status: 'active',
        pricing_scheme: { scheme_type: 'unit', price: priceInCents },
      },
      { headers },
    );
  }

  private async createPagarmePlan(opts: {
    name: string;
    intervalCount: number;
    priceInCents: number;
    installments: number[];
  }) {
    const body = {
      name: opts.name,
      currency: 'BRL',
      interval: 'month',
      interval_count: opts.intervalCount,
      billing_type: 'prepaid',
      // O Pagar.me NÃO aceita 'pix' em payment_methods de um PLANO (só
      // credit_card/debit_card/cash/boleto) → com 'pix' aqui, TODOS os planos
      // falhavam ao criar ("payment_methods field is invalid") e ninguém conseguia
      // assinar. PIX recorrente não é suportado via plano no Pagar.me.
      payment_methods: ['credit_card', 'boleto'],
      installments: opts.installments,
      items: [
        {
          name: `Plano ${opts.name}`,
          quantity: 1,
          pricing_scheme: {
            price: opts.priceInCents,
          },
        },
      ],
    };

    const response = await this.httpService.axiosRef.post(
      `${this.pagarmeBaseUrl}/plans`,
      body,
      {
        headers: {
          Authorization: this.pagarmeAuthHeader,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  async getPagarmePlanId(plan: VendorPlan, billingPeriod: string): Promise<string | null> {
    const local = await this.plansRepository.findOne({
      where: { vendorPlan: plan, billingPeriod },
    });
    return local?.pagarmePlanId || null;
  }

  async getPagarmePlan(plan: VendorPlan, billingPeriod: string): Promise<PagarmePlan | null> {
    return this.plansRepository.findOne({
      where: { vendorPlan: plan, billingPeriod },
    });
  }
}
