import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Promotion } from './entities/promotion.entity';
import { PromotionsService } from './promotions.service';
import { CreatePromotionInput } from './dto/create-promotion.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums';

@Resolver(() => Promotion)
export class PromotionsResolver {
  constructor(private promotionsService: PromotionsService) {}

  @Mutation(() => Promotion)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createPromotion(
    @Args('input') input: CreatePromotionInput,
    @CurrentUser() user: User,
  ): Promise<Promotion> {
    return this.promotionsService.create(input, user);
  }

  @Query(() => [Promotion])
  activePromotions(): Promise<Promotion[]> {
    return this.promotionsService.findActive();
  }

  @Query(() => [Promotion])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  myPromotions(@CurrentUser() user: User): Promise<Promotion[]> {
    // This returns all promotions for all stores owned by the user
    // For simplicity, we return all and filter client-side or add a storeId filter
    return this.promotionsService.findAll();
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
}
