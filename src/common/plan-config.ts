import { VendorPlan } from './enums';

export interface PlanConfig {
  maxStores: number;
  commissionRate: number; // porcentagem (ex: 0.05 = 5%)
  platformDeliveryFee: number; // taxa por entrega em reais
  canPromote: boolean;
  monthlyPrice: number; // em reais
}

export const PLAN_CONFIGS: Record<VendorPlan, PlanConfig> = {
  [VendorPlan.FREE]: {
    maxStores: 1,
    commissionRate: 0.05, // 5%
    platformDeliveryFee: 0.01, // R$0,01 por entrega
    canPromote: false,
    monthlyPrice: 0,
  },
  [VendorPlan.PRO]: {
    maxStores: 3,
    commissionRate: 0.03, // 3%
    platformDeliveryFee: 0.01,
    canPromote: true,
    monthlyPrice: 49.90,
  },
  [VendorPlan.PREMIUM]: {
    maxStores: 10,
    commissionRate: 0.02, // 2%
    platformDeliveryFee: 0.01,
    canPromote: true,
    monthlyPrice: 99.90,
  },
};

export function getPlanConfig(plan: VendorPlan | null): PlanConfig {
  return PLAN_CONFIGS[plan || VendorPlan.FREE];
}
