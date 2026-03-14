import { Resolver, Query, Mutation, Args, Float } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Coupon } from './entities/coupon.entity';
import { CouponsService } from './coupons.service';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { UserRole } from '../common/enums';
import { CouponValidation } from './coupon-validation.type';

@Resolver(() => Coupon)
export class CouponsResolver {
  constructor(private couponsService: CouponsService) {}

  @Mutation(() => Coupon)
  @UseGuards(GqlAuthGuard)
  createCoupon(
    @Args('input') input: CreateCouponInput,
    @CurrentUser() user: VendorUser,
  ): Promise<Coupon> {
    return this.couponsService.create(input, user.id);
  }

  @Mutation(() => Coupon)
  @UseGuards(GqlAuthGuard)
  updateCoupon(
    @Args('input') input: UpdateCouponInput,
    @CurrentUser() user: VendorUser,
  ): Promise<Coupon> {
    return this.couponsService.update(input, user.id);
  }

  @Mutation(() => Coupon)
  @UseGuards(GqlAuthGuard)
  toggleCouponActive(
    @Args('id') id: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Coupon> {
    return this.couponsService.toggleActive(id, user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  deleteCoupon(
    @Args('id') id: string,
    @CurrentUser() user: VendorUser,
  ): Promise<boolean> {
    return this.couponsService.delete(id, user.id);
  }

  @Query(() => [Coupon])
  @UseGuards(GqlAuthGuard)
  storeCoupons(@Args('storeId') storeId: string): Promise<Coupon[]> {
    return this.couponsService.findByStore(storeId);
  }

  // ─── Superadmin ───

  @Query(() => [Coupon])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allCoupons(): Promise<Coupon[]> {
    return this.couponsService.findAll();
  }

  @Mutation(() => Coupon)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  adminToggleCoupon(@Args('id') id: string): Promise<Coupon> {
    return this.couponsService.adminToggle(id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  adminDeleteCoupon(@Args('id') id: string): Promise<boolean> {
    return this.couponsService.adminDelete(id);
  }

  @Query(() => CouponValidation)
  @UseGuards(GqlAuthGuard)
  async validateCoupon(
    @Args('code') code: string,
    @Args('storeId') storeId: string,
    @Args('subtotal', { type: () => Float }) subtotal: number,
  ): Promise<CouponValidation> {
    const { coupon, discount } = await this.couponsService.validateAndCalculate(code, storeId, subtotal);
    return { valid: true, discount, couponId: coupon.id, message: `Desconto de R$ ${discount.toFixed(2)} aplicado!` };
  }
}
