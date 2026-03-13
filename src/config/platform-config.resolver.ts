import { Resolver, Query, Mutation, Args, Float, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformConfigService } from './platform-config.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole, VendorPlan } from '../common/enums';
import { PlanInfo } from '../common/plan-info.type';

@Resolver(() => PlatformConfig)
export class PlatformConfigResolver {
  constructor(private configService: PlatformConfigService) {}

  @Query(() => Float)
  promoPricePerDay(): Promise<number> {
    return this.configService.getPromoPricePerDay();
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  setPromoPricePerDay(@Args('price', { type: () => Float }) price: number): Promise<PlatformConfig> {
    return this.configService.set('promo_price_per_day', String(price));
  }

  @Query(() => Float)
  deliveryPricePerKm(): Promise<number> {
    return this.configService.getDeliveryPricePerKm();
  }

  @Query(() => Float)
  deliveryBasePrice(): Promise<number> {
    return this.configService.getDeliveryBasePrice();
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  setDeliveryPricePerKm(@Args('price', { type: () => Float }) price: number): Promise<PlatformConfig> {
    return this.configService.set('delivery_price_per_km', String(price));
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  setDeliveryBasePrice(@Args('price', { type: () => Float }) price: number): Promise<PlatformConfig> {
    return this.configService.set('delivery_base_price', String(price));
  }

  @Query(() => [PlatformConfig])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  platformConfigs(): Promise<PlatformConfig[]> {
    return this.configService.getAll();
  }

  // ─── Contracts ───

  @Query(() => String)
  contractContent(@Args('type') type: string): Promise<string> {
    return this.configService.getContractContent(type as any);
  }

  @Query(() => String, { nullable: true })
  contractUpdatedAt(@Args('type') type: string): Promise<string | null> {
    return this.configService.getContractUpdatedAt(type as any);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async updateContractContent(
    @Args('type') type: string,
    @Args('content') content: string,
  ): Promise<boolean> {
    await this.configService.updateContractContent(type as any, content);
    return true;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async updatePlanConfig(
    @Args('plan', { type: () => VendorPlan }) plan: VendorPlan,
    @Args('maxStores', { type: () => Int }) maxStores: number,
    @Args('commissionPercent', { type: () => Float }) commissionPercent: number,
    @Args('monthlyPrice', { type: () => Float }) monthlyPrice: number,
    @Args('quarterlyPrice', { type: () => Float }) quarterlyPrice: number,
    @Args('semiannualPrice', { type: () => Float }) semiannualPrice: number,
    @Args('annualPrice', { type: () => Float }) annualPrice: number,
    @Args('freePromosPerWeek', { type: () => Int }) freePromosPerWeek: number,
    @Args('maxProductsPerStore', { type: () => Int }) maxProductsPerStore: number,
    @Args('maxEmailsPerMonth', { type: () => Int }) maxEmailsPerMonth: number,
    @Args('listingPriority', { type: () => Int }) listingPriority: number,
    @Args('highlightDaysPerMonth', { type: () => Int }) highlightDaysPerMonth: number,
    @Args('canUseCoupons') canUseCoupons: boolean,
    @Args('hasAnalytics') hasAnalytics: boolean,
    @Args('supportLevel') supportLevel: string,
    @Args('isContactSales') isContactSales: boolean,
  ): Promise<boolean> {
    await this.configService.updatePlanConfig(plan, {
      maxStores, commissionPercent, monthlyPrice, quarterlyPrice, semiannualPrice, annualPrice,
      freePromosPerWeek, maxProductsPerStore, maxEmailsPerMonth,
      listingPriority, highlightDaysPerMonth,
      canUseCoupons, hasAnalytics, supportLevel, isContactSales,
    });
    return true;
  }
}
