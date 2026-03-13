import { VendorPlan } from './enums';

export interface PlanConfig {
  maxStores: number;
  commissionPercent: number;
  monthlyPrice: number;
  quarterlyPrice: number;
  semiannualPrice: number;
  annualPrice: number;
  freePromosPerWeek: number;
  maxProductsPerStore: number;
  maxEmailsPerMonth: number;
  listingPriority: number;
  highlightDaysPerMonth: number;
  canUseCoupons: boolean;
  hasAnalytics: boolean;
  supportLevel: string;
  isContactSales: boolean;
}

// Discount: quarterly 10% off, semiannual 20% off, annual 30% off
export const PLAN_CONFIGS: Record<VendorPlan, PlanConfig> = {
  [VendorPlan.FREE]: {
    maxStores: 1,
    commissionPercent: 5,
    monthlyPrice: 0,
    quarterlyPrice: 0,
    semiannualPrice: 0,
    annualPrice: 0,
    freePromosPerWeek: 0,
    maxProductsPerStore: 50,
    maxEmailsPerMonth: 0,
    listingPriority: 1,
    highlightDaysPerMonth: 15,
    canUseCoupons: false,
    hasAnalytics: false,
    supportLevel: 'normal',
    isContactSales: false,
  },
  [VendorPlan.PRO]: {
    maxStores: 3,
    commissionPercent: 2,
    monthlyPrice: 49.90,
    quarterlyPrice: 134.73,   // 49.90 * 3 * 0.90
    semiannualPrice: 239.52,  // 49.90 * 6 * 0.80
    annualPrice: 419.16,      // 49.90 * 12 * 0.70
    freePromosPerWeek: 2,
    maxProductsPerStore: 200,
    maxEmailsPerMonth: 50,
    listingPriority: 1,
    highlightDaysPerMonth: 30,
    canUseCoupons: true,
    hasAnalytics: true,
    supportLevel: 'normal',
    isContactSales: false,
  },
  [VendorPlan.PREMIUM]: {
    maxStores: 10,
    commissionPercent: 0,
    monthlyPrice: 99.90,
    quarterlyPrice: 269.73,   // 99.90 * 3 * 0.90
    semiannualPrice: 479.52,  // 99.90 * 6 * 0.80
    annualPrice: 839.16,      // 99.90 * 12 * 0.70
    freePromosPerWeek: 7,
    maxProductsPerStore: 0,
    maxEmailsPerMonth: 200,
    listingPriority: 2,
    highlightDaysPerMonth: 15,
    canUseCoupons: true,
    hasAnalytics: true,
    supportLevel: 'priority',
    isContactSales: false,
  },
  [VendorPlan.ENTERPRISE]: {
    maxStores: 100,
    commissionPercent: 0,
    monthlyPrice: 199.90,
    quarterlyPrice: 539.73,   // 199.90 * 3 * 0.90
    semiannualPrice: 959.52,  // 199.90 * 6 * 0.80
    annualPrice: 1679.16,     // 199.90 * 12 * 0.70
    freePromosPerWeek: 100,
    maxProductsPerStore: 0,
    maxEmailsPerMonth: 0,
    listingPriority: 3,
    highlightDaysPerMonth: 30,
    canUseCoupons: true,
    hasAnalytics: true,
    supportLevel: 'dedicated',
    isContactSales: false,
  },
  [VendorPlan.CUSTOM]: {
    maxStores: 0,
    commissionPercent: 0,
    monthlyPrice: 0,
    quarterlyPrice: 0,
    semiannualPrice: 0,
    annualPrice: 0,
    freePromosPerWeek: 0,
    maxProductsPerStore: 0,
    maxEmailsPerMonth: 0,
    listingPriority: 0,
    highlightDaysPerMonth: 0,
    canUseCoupons: false,
    hasAnalytics: false,
    supportLevel: 'normal',
    isContactSales: true,
  },
};

export function getPlanConfig(plan: VendorPlan | null): PlanConfig {
  return PLAN_CONFIGS[plan || VendorPlan.FREE];
}
