import { VendorPlan } from './enums';

export interface PlanConfig {
  maxStores: number;
  canPromote: boolean;
  monthlyPrice: number; // em reais
}

export const PLAN_CONFIGS: Record<VendorPlan, PlanConfig> = {
  [VendorPlan.FREE]: {
    maxStores: 1,
    canPromote: false,
    monthlyPrice: 0,
  },
  [VendorPlan.PRO]: {
    maxStores: 3,
    canPromote: true,
    monthlyPrice: 49.90,
  },
  [VendorPlan.PREMIUM]: {
    maxStores: 10,
    canPromote: true,
    monthlyPrice: 99.90,
  },
};

export function getPlanConfig(plan: VendorPlan | null): PlanConfig {
  return PLAN_CONFIGS[plan || VendorPlan.FREE];
}
