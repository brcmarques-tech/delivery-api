import { Resolver, Query, Mutation, Args, Float, Subscription } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { Promotion } from './entities/promotion.entity';
import { PromotionsService } from './promotions.service';
import { CreatePromotionInput } from './dto/create-promotion.input';
import { PaymentsService } from '../payments/payments.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

@Resolver(() => Promotion)
export class PromotionsResolver {
  constructor(
    private promotionsService: PromotionsService,
    private paymentsService: PaymentsService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  @Mutation(() => Promotion)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  async createPromotion(
    @Args('input') input: CreatePromotionInput,
    @CurrentUser() user: User,
  ): Promise<Promotion> {
    const promotion = await this.promotionsService.create(input, user);

    if (Number(promotion.adCost) === 0) {
      // Free promotion (fully covered by badge credit) — activate immediately
      await this.promotionsService.markAsPaid(promotion.id);
      promotion.isPaid = true;
    } else {
      // Generate checkout for payment
      try {
        const payment = await this.paymentsService.createPromotionCheckout(promotion, user);
        if (payment.checkoutUrl) {
          promotion.checkoutUrl = payment.checkoutUrl;
          await this.promotionsService.saveCheckoutUrl(promotion.id, payment.checkoutUrl);
        }
      } catch {
        // If MP fails, promotion is created but without checkout — admin can approve manually
      }
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
  myPromotions(@CurrentUser() user: User): Promise<Promotion[]> {
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
  togglePromotionActive(@Args('id') id: string): Promise<Promotion> {
    return this.promotionsService.toggleActive(id);
  }

  @Mutation(() => Promotion)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  markPromotionPaid(@Args('id') id: string): Promise<Promotion> {
    return this.promotionsService.markAsPaid(id);
  }

  @Mutation(() => Promotion)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  swapPromotionProduct(
    @Args('id') id: string,
    @Args('productId') productId: string,
    @Args('promotionalPrice', { type: () => Float }) promotionalPrice: number,
    @Args('title') title: string,
    @CurrentUser() user: User,
  ): Promise<Promotion> {
    return this.promotionsService.swapProduct(id, productId, promotionalPrice, title, user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  deletePromotion(
    @Args('id') id: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.promotionsService.delete(id, user.id);
  }

  @Subscription(() => Promotion)
  promotionUpdated() {
    return this.pubSub.asyncIterableIterator('promotionUpdated');
  }
}
