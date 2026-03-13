import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlanConfig } from '../common/plan-config';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums';

@Injectable()
export class PlatformConfigService {
  constructor(
    @InjectRepository(PlatformConfig)
    private configRepository: Repository<PlatformConfig>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async get(key: string, defaultValue: string = '0'): Promise<string> {
    const config = await this.configRepository.findOne({ where: { key } });
    return config?.value ?? defaultValue;
  }

  async set(key: string, value: string): Promise<PlatformConfig> {
    let config = await this.configRepository.findOne({ where: { key } });
    if (config) {
      config.value = value;
    } else {
      config = this.configRepository.create({ key, value });
    }
    return this.configRepository.save(config);
  }

  async getAll(): Promise<PlatformConfig[]> {
    return this.configRepository.find();
  }

  async getPromoPricePerDay(): Promise<number> {
    const value = await this.get('promo_price_per_day', '1');
    return parseFloat(value);
  }

  async getDeliveryPricePerKm(): Promise<number> {
    const value = await this.get('delivery_price_per_km', '1.50');
    return parseFloat(value);
  }

  async getDeliveryBasePrice(): Promise<number> {
    const value = await this.get('delivery_base_price', '3.00');
    return parseFloat(value);
  }

  async getPlanConfig(plan: string): Promise<PlanConfig> {
    const defaults: Record<string, PlanConfig> = {
      FREE: {
        maxStores: 1, commissionPercent: 5, monthlyPrice: 0,
        quarterlyPrice: 0, semiannualPrice: 0, annualPrice: 0,
        freePromosPerWeek: 0, maxProductsPerStore: 50, maxEmailsPerMonth: 0,
        listingPriority: 1, highlightDaysPerMonth: 15,
        canUseCoupons: false, hasAnalytics: false,
        supportLevel: 'normal', isContactSales: false,
      },
      PRO: {
        maxStores: 3, commissionPercent: 2, monthlyPrice: 49.90,
        quarterlyPrice: 134.73, semiannualPrice: 239.52, annualPrice: 419.16,
        freePromosPerWeek: 2, maxProductsPerStore: 200, maxEmailsPerMonth: 50,
        listingPriority: 1, highlightDaysPerMonth: 30,
        canUseCoupons: true, hasAnalytics: true,
        supportLevel: 'normal', isContactSales: false,
      },
      PREMIUM: {
        maxStores: 10, commissionPercent: 0, monthlyPrice: 99.90,
        quarterlyPrice: 269.73, semiannualPrice: 479.52, annualPrice: 839.16,
        freePromosPerWeek: 7, maxProductsPerStore: 0, maxEmailsPerMonth: 200,
        listingPriority: 2, highlightDaysPerMonth: 15,
        canUseCoupons: true, hasAnalytics: true,
        supportLevel: 'priority', isContactSales: false,
      },
      ENTERPRISE: {
        maxStores: 100, commissionPercent: 0, monthlyPrice: 199.90,
        quarterlyPrice: 539.73, semiannualPrice: 959.52, annualPrice: 1679.16,
        freePromosPerWeek: 100, maxProductsPerStore: 0, maxEmailsPerMonth: 0,
        listingPriority: 3, highlightDaysPerMonth: 30,
        canUseCoupons: true, hasAnalytics: true,
        supportLevel: 'dedicated', isContactSales: false,
      },
      CUSTOM: {
        maxStores: 0, commissionPercent: 0, monthlyPrice: 0,
        quarterlyPrice: 0, semiannualPrice: 0, annualPrice: 0,
        freePromosPerWeek: 0, maxProductsPerStore: 0, maxEmailsPerMonth: 0,
        listingPriority: 0, highlightDaysPerMonth: 0,
        canUseCoupons: false, hasAnalytics: false,
        supportLevel: 'normal', isContactSales: true,
      },
    };
    const def = defaults[plan] || defaults.FREE;
    const p = plan.toLowerCase();

    const maxStores = parseInt(await this.get(`plan_${p}_max_stores`, String(def.maxStores)));
    const commissionPercent = parseFloat(await this.get(`plan_${p}_commission_percent`, String(def.commissionPercent)));
    const monthlyPrice = parseFloat(await this.get(`plan_${p}_monthly_price`, String(def.monthlyPrice)));
    const quarterlyPrice = parseFloat(await this.get(`plan_${p}_quarterly_price`, String(def.quarterlyPrice)));
    const semiannualPrice = parseFloat(await this.get(`plan_${p}_semiannual_price`, String(def.semiannualPrice)));
    const annualPrice = parseFloat(await this.get(`plan_${p}_annual_price`, String(def.annualPrice)));
    const freePromosPerWeek = parseInt(await this.get(`plan_${p}_free_promos_per_week`, String(def.freePromosPerWeek)));
    const maxProductsPerStore = parseInt(await this.get(`plan_${p}_max_products_per_store`, String(def.maxProductsPerStore)));
    const maxEmailsPerMonth = parseInt(await this.get(`plan_${p}_max_emails_per_month`, String(def.maxEmailsPerMonth)));
    const listingPriority = parseInt(await this.get(`plan_${p}_listing_priority`, String(def.listingPriority)));
    const highlightDaysPerMonth = parseInt(await this.get(`plan_${p}_highlight_days_per_month`, String(def.highlightDaysPerMonth)));
    const canUseCoupons = (await this.get(`plan_${p}_can_use_coupons`, String(def.canUseCoupons))) === 'true';
    const hasAnalytics = (await this.get(`plan_${p}_has_analytics`, String(def.hasAnalytics))) === 'true';
    const supportLevel = await this.get(`plan_${p}_support_level`, def.supportLevel);
    const isContactSales = (await this.get(`plan_${p}_is_contact_sales`, String(def.isContactSales))) === 'true';

    return {
      maxStores, commissionPercent, monthlyPrice, quarterlyPrice, semiannualPrice, annualPrice,
      freePromosPerWeek, maxProductsPerStore, maxEmailsPerMonth,
      listingPriority, highlightDaysPerMonth,
      canUseCoupons, hasAnalytics, supportLevel, isContactSales,
    };
  }

  // ─── Contracts ───

  async getContractContent(type: 'terms' | 'subscription'): Promise<string> {
    return this.get(`contract_${type}_content`, '');
  }

  async getContractUpdatedAt(type: 'terms' | 'subscription'): Promise<string | null> {
    const val = await this.get(`contract_${type}_updated_at`, '');
    return val || null;
  }

  async updateContractContent(type: string, content: string): Promise<void> {
    await this.set(`contract_${type}_content`, content);
    await this.set(`contract_${type}_updated_at`, new Date().toISOString());

    // Reset acceptance for the affected users so they must re-accept
    if (type === 'subscription') {
      // Subscription contract: reset only vendors' subscription acceptance
      await this.usersRepository
        .createQueryBuilder()
        .update(User)
        .set({ acceptedSubscriptionTermsAt: null as any })
        .where('acceptedSubscriptionTermsAt IS NOT NULL')
        .execute();
    } else {
      // Role-specific terms: reset acceptedTermsAt for that role only
      const roleMap: Record<string, UserRole> = {
        vendor: UserRole.VENDOR,
        customer: UserRole.CUSTOMER,
        deliverer: UserRole.DELIVERER,
      };
      const role = roleMap[type];
      if (role) {
        await this.usersRepository
          .createQueryBuilder()
          .update(User)
          .set({ acceptedTermsAt: null as any })
          .where('acceptedTermsAt IS NOT NULL AND role = :role', { role })
          .execute();
      }
    }
  }

  async updatePlanConfig(
    plan: string,
    config: PlanConfig,
  ): Promise<void> {
    const p = plan.toLowerCase();
    await this.set(`plan_${p}_max_stores`, String(config.maxStores));
    await this.set(`plan_${p}_commission_percent`, String(config.commissionPercent));
    await this.set(`plan_${p}_monthly_price`, String(config.monthlyPrice));
    await this.set(`plan_${p}_quarterly_price`, String(config.quarterlyPrice));
    await this.set(`plan_${p}_semiannual_price`, String(config.semiannualPrice));
    await this.set(`plan_${p}_annual_price`, String(config.annualPrice));
    await this.set(`plan_${p}_free_promos_per_week`, String(config.freePromosPerWeek));
    await this.set(`plan_${p}_max_products_per_store`, String(config.maxProductsPerStore));
    await this.set(`plan_${p}_max_emails_per_month`, String(config.maxEmailsPerMonth));
    await this.set(`plan_${p}_listing_priority`, String(config.listingPriority));
    await this.set(`plan_${p}_highlight_days_per_month`, String(config.highlightDaysPerMonth));
    await this.set(`plan_${p}_can_use_coupons`, String(config.canUseCoupons));
    await this.set(`plan_${p}_has_analytics`, String(config.hasAnalytics));
    await this.set(`plan_${p}_support_level`, config.supportLevel);
    await this.set(`plan_${p}_is_contact_sales`, String(config.isContactSales));
  }
}
