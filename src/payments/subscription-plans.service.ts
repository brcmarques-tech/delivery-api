import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { PagarmePlan } from './entities/pagarme-plan.entity';
import { VendorPlan } from '../common/enums';
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
  ) {
    const secretKey = this.configService.get('PAGARME_SECRET_KEY') || '';
    this.pagarmeAuthHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');
  }

  async onModuleInit() {
    try {
      await this.seedPlans();
    } catch (err) {
      this.logger.error('Failed to seed Pagar.me plans', err.message);
    }
  }

  private async seedPlans() {
    for (const plan of PAID_PLANS) {
      const config = PLAN_CONFIGS[plan];
      for (const period of BILLING_PERIODS) {
        const planName = `${plan}_${period.key.toUpperCase()}`;
        const existing = await this.plansRepository.findOne({
          where: { vendorPlan: plan, billingPeriod: period.key },
        });

        if (existing) {
          continue;
        }

        const priceInCents = Math.round(config[getPriceKey(period.key)] * 100);
        if (priceInCents <= 0) continue;

        const installmentsArray = Array.from(
          { length: period.installments },
          (_, i) => i + 1,
        );

        try {
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
        } catch (err) {
          this.logger.error(`Failed to create plan ${planName}: ${err.response?.data?.message || err.message}`);
        }
      }
    }
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
