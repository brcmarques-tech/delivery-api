import { Resolver, Query, Mutation, Args, Float, Int } from '@nestjs/graphql';
import { UseGuards, Inject, forwardRef, Logger } from '@nestjs/common';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformConfigService } from './platform-config.service';
import { SubscriptionPlansService } from '../payments/subscription-plans.service';
import { MailService } from '../mail/mail.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permission } from '../auth/decorators/permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole, VendorPlan } from '../common/enums';
import { PlanInfo } from '../common/plan-info.type';

@Resolver(() => PlatformConfig)
export class PlatformConfigResolver {
  private readonly logger = new Logger(PlatformConfigResolver.name);

  constructor(
    private configService: PlatformConfigService,
    private mailService: MailService,
    @Inject(forwardRef(() => SubscriptionPlansService))
    private subscriptionPlansService: SubscriptionPlansService,
  ) {}

  @Query(() => Float)
  promoPricePerDay(): Promise<number> {
    return this.configService.getPromoPricePerDay();
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('promotions')
  async setPromoPricePerDay(@Args('price', { type: () => Float }) price: number, @CurrentUser() admin: any): Promise<PlatformConfig> {
    const result = await this.configService.set('promo_price_per_day', String(price));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Preco de promocao/dia alterado', `Novo valor: R$ ${price}`).catch(() => {});
    return result;
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
  @Permission('deliveries')
  async setDeliveryPricePerKm(@Args('price', { type: () => Float }) price: number, @CurrentUser() admin: any): Promise<PlatformConfig> {
    const result = await this.configService.set('delivery_price_per_km', String(price));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Preco de entrega/km alterado', `Novo valor: R$ ${price}`).catch(() => {});
    return result;
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('deliveries')
  async setDeliveryBasePrice(@Args('price', { type: () => Float }) price: number, @CurrentUser() admin: any): Promise<PlatformConfig> {
    const result = await this.configService.set('delivery_base_price', String(price));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Preco base de entrega alterado', `Novo valor: R$ ${price}`).catch(() => {});
    return result;
  }

  @Query(() => Float)
  deliveryCommissionPercent(): Promise<number> {
    return this.configService.getDeliveryCommissionPercent();
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('deliveries')
  async setDeliveryCommissionPercent(@Args('percent', { type: () => Float }) percent: number, @CurrentUser() admin: any): Promise<PlatformConfig> {
    const result = await this.configService.set('delivery_commission_percent', String(percent));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Comissao sobre entregas alterada', `Novo valor: ${percent}%`).catch(() => {});
    return result;
  }

  @Query(() => Float)
  minimumOrderPlatform(): Promise<number> {
    return this.configService.getMinimumOrderPlatform();
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('deliveries')
  async setMinimumOrderPlatform(@Args('price', { type: () => Float }) price: number, @CurrentUser() admin: any): Promise<PlatformConfig> {
    const result = await this.configService.set('minimum_order_platform', String(price));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Pedido minimo da plataforma alterado', `Novo valor: R$ ${price}`).catch(() => {});
    return result;
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
  @Permission('contracts')
  async updateContractContent(
    @Args('type') type: string,
    @Args('content') content: string,
    @CurrentUser() admin: any,
  ): Promise<boolean> {
    await this.configService.updateContractContent(type as any, content);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Contrato atualizado', `Tipo: ${type}`).catch(() => {});
    return true;
  }

  // ─── Badge / Verification Config ───

  @Query(() => String)
  async badgeConfig(): Promise<string> {
    const config = await this.configService.getAllBadgeConfig();
    return JSON.stringify(config);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('badges')
  async updateBadgeThresholds(
    @Args('thresholds') thresholds: string,
    @CurrentUser() admin: any,
  ): Promise<boolean> {
    await this.configService.setBadgeThresholds(JSON.parse(thresholds));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Thresholds de badge atualizados', `Valores: ${thresholds}`).catch(() => {});
    return true;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('badges')
  async updateBadgePoints(
    @Args('points') points: string,
    @CurrentUser() admin: any,
  ): Promise<boolean> {
    await this.configService.setBadgePoints(JSON.parse(points));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Pontos de badge atualizados', `Valores: ${points}`).catch(() => {});
    return true;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('badges')
  async updateBadgeRewards(
    @Args('level') level: string,
    @Args('rewards') rewards: string,
    @CurrentUser() admin: any,
  ): Promise<boolean> {
    await this.configService.setBadgeRewards(level, JSON.parse(rewards));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Recompensas de badge atualizadas', `Nivel: ${level}\nRecompensas: ${rewards}`).catch(() => {});
    return true;
  }

  // ─── Plans ───

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
    @CurrentUser() admin: any,
  ): Promise<boolean> {
    await this.configService.updatePlanConfig(plan, {
      maxStores, commissionPercent, monthlyPrice, quarterlyPrice, semiannualPrice, annualPrice,
      freePromosPerWeek, maxProductsPerStore, maxEmailsPerMonth,
      listingPriority, highlightDaysPerMonth,
      canUseCoupons, hasAnalytics, supportLevel, isContactSales,
    });
    // Bug 3.7: sem isso, o preco novo ficava so na config — o plano do Pagar.me
    // (que e quem cobra) continuava com o valor antigo e toda assinatura NOVA
    // saia pelo preco errado. Falha aqui nao desfaz a config: o syncPlans
    // re-tenta no proximo boot e no proximo save.
    try {
      await this.subscriptionPlansService.syncPlans(plan);
    } catch (err) {
      this.logger.error(`syncPlans falhou apos updatePlanConfig(${plan}): ${err.message}`);
    }
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Configuracao de plano atualizada', `Plano: ${plan}\nLojas: ${maxStores}, Comissao: ${commissionPercent}%, Mensal: R$ ${monthlyPrice}`).catch(() => {});
    return true;
  }
}
