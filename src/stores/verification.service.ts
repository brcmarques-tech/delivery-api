import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Store } from './entities/store.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { Coupon } from '../coupons/entities/coupon.entity';
import { VerificationLevel } from '../common/enums/verification-level.enum';
import { VendorPlan } from '../common/enums/vendor-plan.enum';
import { PlatformConfigService } from '../config/platform-config.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

const LEVEL_ORDER = [
  VerificationLevel.NONE,
  VerificationLevel.BRONZE,
  VerificationLevel.SILVER,
  VerificationLevel.GOLD,
  VerificationLevel.DIAMOND,
];

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    @InjectRepository(VendorUser)
    private vendorUsersRepository: Repository<VendorUser>,
    @InjectRepository(Coupon)
    private couponsRepository: Repository<Coupon>,
    @Inject(forwardRef(() => PlatformConfigService))
    private configService: PlatformConfigService,
    private whatsAppService: WhatsAppService,
  ) {}

  async getThresholds(): Promise<Record<string, number>> {
    return this.configService.getBadgeThresholds();
  }

  async getPointsConfig(): Promise<Record<string, number>> {
    return this.configService.getBadgePoints();
  }

  async calculateLevel(score: number, vendorPlan?: string | null): Promise<VerificationLevel> {
    const thresholds = await this.getThresholds();

    if (vendorPlan === VendorPlan.ENTERPRISE) {
      if (score >= thresholds.DIAMOND) return VerificationLevel.DIAMOND;
      return VerificationLevel.GOLD;
    }

    if (score >= thresholds.DIAMOND) return VerificationLevel.DIAMOND;
    if (score >= thresholds.GOLD) return VerificationLevel.GOLD;
    if (score >= thresholds.SILVER) return VerificationLevel.SILVER;
    if (score >= thresholds.BRONZE) return VerificationLevel.BRONZE;
    return VerificationLevel.NONE;
  }

  async getNextLevel(current: VerificationLevel): Promise<{ level: VerificationLevel; threshold: number } | null> {
    const thresholds = await this.getThresholds();
    switch (current) {
      case VerificationLevel.NONE:
        return { level: VerificationLevel.BRONZE, threshold: thresholds.BRONZE };
      case VerificationLevel.BRONZE:
        return { level: VerificationLevel.SILVER, threshold: thresholds.SILVER };
      case VerificationLevel.SILVER:
        return { level: VerificationLevel.GOLD, threshold: thresholds.GOLD };
      case VerificationLevel.GOLD:
        return { level: VerificationLevel.DIAMOND, threshold: thresholds.DIAMOND };
      case VerificationLevel.DIAMOND:
        return null;
    }
  }

  private async checkAutoGrant(store: Store, oldLevel: VerificationLevel): Promise<void> {
    if (oldLevel !== VerificationLevel.NONE) return;
    if (store.verificationLevel === VerificationLevel.NONE) return;
    if (store.badgeClaimCount > 0) return;

    const rewards = await this.configService.getBadgeRewards(store.verificationLevel);
    const thresholds = await this.getThresholds();
    const threshold = thresholds[store.verificationLevel] || 0;

    this.logger.log(`Auto-granting first badge rewards to store ${store.id} (level: ${store.verificationLevel})`);

    store.freePromoDaysCredit = rewards.freePromoDays || 0;

    if (rewards.commissionReduction > 0) {
      store.commissionReductionPercent = rewards.commissionReduction;
      store.commissionReductionExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }

    if (rewards.freeTrialDays > 0 && store.owner?.id) {
      await this.grantTrialDays(store.owner.id, rewards.freeTrialDays);
    }

    store.badgeClaimCount = 1;
    store.lastClaimedScore = threshold;

    await this.storesRepository.save(store);
  }

  private async grantTrialDays(userId: string, days: number): Promise<void> {
    const user = await this.vendorUsersRepository.findOne({ where: { id: userId } });
    if (!user) return;

    const now = new Date();
    const currentExpiry = user.planExpiresAt ? new Date(user.planExpiresAt) : now;
    const base = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    user.planExpiresAt = newExpiry;
    if (!user.vendorPlan) {
      user.vendorPlan = VendorPlan.PRO;
    }

    await this.vendorUsersRepository.save(user);
    this.logger.log(`Granted ${days} trial days to vendor ${userId}, expires: ${newExpiry.toISOString()}`);
  }

  private async createRewardCoupon(store: Store, couponPercent: number): Promise<void> {
    if (couponPercent <= 0) return;

    const code = `SELO-${store.name.replace(/\s+/g, '').substring(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

    const coupon = this.couponsRepository.create({
      code,
      discountType: 'PERCENT',
      discountValue: couponPercent,
      minimumOrder: 0,
      maxDiscount: null as any,
      maxUses: 1,
      isActive: true,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      store,
    });

    await this.couponsRepository.save(coupon);
    this.logger.log(`Created reward coupon ${code} (${couponPercent}%) for store ${store.id}`);
  }

  async claimBadgeReward(storeId: string, level: string, userId: string): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { id: storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    if (store.owner.id !== userId) {
      throw new BadRequestException('Voce nao e dono desta loja');
    }

    const thresholds = await this.getThresholds();
    const threshold = thresholds[level];
    if (!threshold) throw new BadRequestException('Nivel invalido');

    const claimablePoints = store.verificationScore - store.lastClaimedScore;
    if (claimablePoints < threshold) {
      throw new BadRequestException(
        `Pontos insuficientes para resgatar. Voce tem ${claimablePoints} pontos disponiveis, precisa de ${threshold}.`,
      );
    }

    const rewards = await this.configService.getBadgeRewards(level);
    const isFirstEver = store.badgeClaimCount === 0;

    store.freePromoDaysCredit = rewards.freePromoDays || 0;

    if (rewards.commissionReduction > 0) {
      store.commissionReductionPercent = rewards.commissionReduction;
      store.commissionReductionExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }

    if (isFirstEver) {
      if (rewards.freeTrialDays > 0 && store.owner?.id) {
        await this.grantTrialDays(store.owner.id, rewards.freeTrialDays);
      }
    } else {
      if (rewards.couponValue > 0) {
        await this.createRewardCoupon(store, rewards.couponValue);
      }
    }

    store.lastClaimedScore += threshold;
    store.badgeClaimCount += 1;

    const saved = await this.storesRepository.save(store);

    if (store.owner?.phone) {
      this.whatsAppService.notifyBadgeReward(store.owner.phone, store.name, level).catch(() => {});
    }

    return saved;
  }

  async getClaimableInfo(store: Store): Promise<{
    claimablePoints: number;
    availableLevels: { level: string; threshold: number; canClaim: boolean }[];
  }> {
    const thresholds = await this.getThresholds();
    const claimablePoints = store.verificationScore - store.lastClaimedScore;

    const availableLevels = Object.entries(thresholds).map(([level, threshold]) => ({
      level,
      threshold,
      canClaim: claimablePoints >= threshold,
    }));

    return { claimablePoints, availableLevels };
  }

  async onProductAdded(storeId: string, vendorPlan?: string): Promise<Store> {
    const store = await this.storesRepository.findOne({ where: { id: storeId }, relations: ['owner'] });
    if (!store) throw new NotFoundException('Loja nao encontrada');

    const oldLevel = store.verificationLevel;
    const points = await this.getPointsConfig();
    store.totalProducts += 1;
    store.verificationScore += points.PER_PRODUCT;
    store.verificationLevel = await this.calculateLevel(
      store.verificationScore,
      vendorPlan ?? store.owner?.vendorPlan ?? undefined,
    );

    const saved = await this.storesRepository.save(store);
    await this.checkAutoGrant(saved, oldLevel);
    return saved;
  }

  async onSaleCompleted(storeId: string, vendorPlan?: string): Promise<Store> {
    const store = await this.storesRepository.findOne({ where: { id: storeId }, relations: ['owner'] });
    if (!store) throw new NotFoundException('Loja nao encontrada');

    const oldLevel = store.verificationLevel;
    const points = await this.getPointsConfig();
    store.totalSales += 1;
    store.verificationScore += points.PER_SALE;
    store.verificationLevel = await this.calculateLevel(
      store.verificationScore,
      vendorPlan ?? store.owner?.vendorPlan ?? undefined,
    );

    const saved = await this.storesRepository.save(store);
    await this.checkAutoGrant(saved, oldLevel);
    return saved;
  }

  async recalculateScore(storeId: string): Promise<Store> {
    const store = await this.storesRepository.findOne({ where: { id: storeId }, relations: ['owner'] });
    if (!store) throw new NotFoundException('Loja nao encontrada');

    const oldLevel = store.verificationLevel;
    const points = await this.getPointsConfig();
    const monthsActive = Math.floor(
      (Date.now() - new Date(store.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30),
    );

    store.verificationScore =
      store.totalProducts * points.PER_PRODUCT +
      store.totalSales * points.PER_SALE +
      monthsActive * points.PER_MONTH_ACTIVE;

    store.verificationLevel = await this.calculateLevel(
      store.verificationScore,
      store.owner?.vendorPlan ?? undefined,
    );

    const saved = await this.storesRepository.save(store);
    await this.checkAutoGrant(saved, oldLevel);
    return saved;
  }

  async onPlanChanged(ownerId: string, plan: string): Promise<void> {
    const stores = await this.storesRepository.find({
      where: { owner: { id: ownerId } },
      relations: ['owner'],
    });

    for (const store of stores) {
      const oldLevel = store.verificationLevel;
      store.verificationLevel = await this.calculateLevel(store.verificationScore, plan);
      const saved = await this.storesRepository.save(store);
      await this.checkAutoGrant(saved, oldLevel);
    }
  }
}
