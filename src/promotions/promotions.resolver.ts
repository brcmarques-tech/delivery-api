import { Resolver, Query, Mutation, Args, Float, Subscription } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { Promotion } from './entities/promotion.entity';
import { PromotionsService } from './promotions.service';
import { CreatePromotionInput } from './dto/create-promotion.input';
import { PaymentsService } from '../payments/payments.service';
import { MailService } from '../mail/mail.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { UserRole } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

@Resolver(() => Promotion)
export class PromotionsResolver {
  constructor(
    private promotionsService: PromotionsService,
    private paymentsService: PaymentsService,
    private mailService: MailService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  @Mutation(() => Promotion)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  async createPromotion(
    @Args('input') input: CreatePromotionInput,
    @CurrentUser() user: VendorUser,
  ): Promise<Promotion> {
    const promotion = await this.promotionsService.create(input, user);

    if (Number(promotion.adCost) === 0) {
      await this.promotionsService.markAsPaid(promotion.id);
      promotion.isPaid = true;
    } else {
      try {
        const payment = await this.paymentsService.createPromotionCheckout(promotion, user);
        if (payment.checkoutUrl) {
          promotion.checkoutUrl = payment.checkoutUrl;
          await this.promotionsService.saveCheckoutUrl(promotion.id, payment.checkoutUrl);
        }
      } catch {}
    }

    return promotion;
  }

  @Query(() => [Promotion])
  activePromotions(): Promise<Promotion[]> {
    return this.promotionsService.findActive();
  }

  @Query(() => [Promotion])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  myPromotions(@CurrentUser() user: VendorUser): Promise<Promotion[]> {
    return this.promotionsService.findByOwner(user.id);
  }

  @Query(() => [Promotion])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allPromotions(): Promise<Promotion[]> {
    return this.promotionsService.findAll();
  }

  @Mutation(() => Promotion)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async togglePromotionActive(@Args('id') id: string, @CurrentUser() admin: any): Promise<Promotion> {
    const result = await this.promotionsService.toggleActive(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, `Promocao ${result.isActive ? 'ativada' : 'desativada'}`, `Promocao: ${result.title} (ID: ${result.id})`).catch(() => {});
    return result;
  }

  @Mutation(() => Promotion)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async markPromotionPaid(@Args('id') id: string, @CurrentUser() admin: any): Promise<Promotion> {
    const result = await this.promotionsService.markAsPaid(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Promocao marcada como paga', `Promocao: ${result.title} (ID: ${result.id})`).catch(() => {});
    return result;
  }

  @Mutation(() => Promotion)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  swapPromotionProduct(
    @Args('id') id: string,
    @Args('productId') productId: string,
    @Args('promotionalPrice', { type: () => Float }) promotionalPrice: number,
    @Args('title') title: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Promotion> {
    return this.promotionsService.swapProduct(id, productId, promotionalPrice, title, user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  deletePromotion(
    @Args('id') id: string,
    @CurrentUser() user: VendorUser,
  ): Promise<boolean> {
    return this.promotionsService.delete(id, user.id);
  }

  // Exige autenticação: antes qualquer cliente (até anônimo) podia assinar e
  // colher dados de promoção de todos os lojistas em tempo real. O payload
  // publicado também não carrega mais checkoutUrl/adCost (ver promotions.service).
  @Subscription(() => Promotion)
  @UseGuards(GqlAuthGuard)
  promotionUpdated() {
    return this.pubSub.asyncIterableIterator('promotionUpdated');
  }
}
