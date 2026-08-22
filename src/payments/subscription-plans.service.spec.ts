import { SubscriptionPlansService } from './subscription-plans.service';
import { VendorPlan } from '../common/enums';

// Bug 3.7: o preco configurado no superadmin divergia do plano do Pagar.me (quem
// de fato cobra a recorrencia). Estes testes cobrem o alinhamento: divergiu →
// atualiza o item do plano no Pagar.me e o espelho local; igual → nao toca em
// nada; falha remota → nao grava o preco novo localmente (retry no proximo sync).

function makeConfig(monthlyPrice: number) {
  return {
    maxStores: 1,
    commissionPercent: 5,
    monthlyPrice,
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
    isContactSales: false,
  };
}

describe('SubscriptionPlansService.syncPlans (bug 3.7)', () => {
  let service: SubscriptionPlansService;
  let plansRepository: any;
  let axiosRef: any;
  let platformConfigService: any;

  const existingMonthlyPro = () => ({
    id: 'local-1',
    pagarmePlanId: 'plan_pro_monthly',
    vendorPlan: VendorPlan.PRO,
    billingPeriod: 'monthly',
    intervalCount: 1,
    priceInCents: 4990,
    installments: 1,
  });

  beforeEach(() => {
    plansRepository = {
      // so o PRO mensal existe; os outros periodos tem preco 0 na config e sao pulados
      findOne: jest.fn(async ({ where }: any) =>
        where.vendorPlan === VendorPlan.PRO && where.billingPeriod === 'monthly'
          ? existingMonthlyPro()
          : null,
      ),
      save: jest.fn(async (x: any) => x),
      create: jest.fn((x: any) => x),
    };
    axiosRef = {
      get: jest.fn(async () => ({
        data: { items: [{ id: 'item_1', name: 'Plano PRO_MONTHLY' }] },
      })),
      put: jest.fn(async () => ({ data: {} })),
      post: jest.fn(async () => ({ data: { id: 'plan_new' } })),
    };
    platformConfigService = {
      getPlanConfig: jest.fn(async (plan: string) =>
        makeConfig(plan === VendorPlan.PRO ? 59.9 : 0),
      ),
    };
    service = new SubscriptionPlansService(
      plansRepository,
      { get: jest.fn(() => 'sk_test_x') } as any,
      { axiosRef } as any,
      platformConfigService,
    );
  });

  it('preco divergente: atualiza o item do plano no Pagar.me e o espelho local', async () => {
    await service.syncPlans(VendorPlan.PRO);

    expect(axiosRef.get).toHaveBeenCalledWith(
      'https://api.pagar.me/core/v5/plans/plan_pro_monthly',
      expect.anything(),
    );
    expect(axiosRef.put).toHaveBeenCalledWith(
      'https://api.pagar.me/core/v5/plans/plan_pro_monthly/items/item_1',
      expect.objectContaining({ pricing_scheme: { scheme_type: 'unit', price: 5990 } }),
      expect.anything(),
    );
    expect(plansRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ pagarmePlanId: 'plan_pro_monthly', priceInCents: 5990 }),
    );
  });

  it('preco igual: nao chama o Pagar.me nem regrava o espelho', async () => {
    platformConfigService.getPlanConfig = jest.fn(async () => makeConfig(49.9));

    await service.syncPlans(VendorPlan.PRO);

    expect(axiosRef.get).not.toHaveBeenCalled();
    expect(axiosRef.put).not.toHaveBeenCalled();
    expect(plansRepository.save).not.toHaveBeenCalled();
  });

  it('falha remota: nao grava o preco novo localmente e nao propaga o erro', async () => {
    axiosRef.put = jest.fn(async () => {
      throw new Error('pagarme fora do ar');
    });

    await expect(service.syncPlans(VendorPlan.PRO)).resolves.toBeUndefined();
    // o espelho local NAO pode registrar 5990 sem o Pagar.me ter aceitado —
    // senao a divergencia ficaria invisivel para sempre
    expect(plansRepository.save).not.toHaveBeenCalled();
  });
});
