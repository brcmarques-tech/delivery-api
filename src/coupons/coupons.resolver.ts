import { Resolver, Query, Mutation, Args, Float } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Coupon } from './entities/coupon.entity';
import { CouponsService } from './coupons.service';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';
import { MailService } from '../mail/mail.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { UserRole } from '../common/enums';
import { CouponValidation } from './coupon-validation.type';

@Resolver(() => Coupon)
export class CouponsResolver {
  constructor(
    private couponsService: CouponsService,
    private mailService: MailService,
  ) {}

  @Mutation(() => Coupon)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createCoupon(
    @Args('input') input: CreateCouponInput,
    @CurrentUser() user: VendorUser,
  ): Promise<Coupon> {
    return this.couponsService.create(input, user.id);
  }

  @Mutation(() => Coupon)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  updateCoupon(
    @Args('input') input: UpdateCouponInput,
    @CurrentUser() user: VendorUser,
  ): Promise<Coupon> {
    return this.couponsService.update(input, user.id);
  }

  @Mutation(() => Coupon)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  toggleCouponActive(
    @Args('id') id: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Coupon> {
    return this.couponsService.toggleActive(id, user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  deleteCoupon(
    @Args('id') id: string,
    @CurrentUser() user: VendorUser,
  ): Promise<boolean> {
    return this.couponsService.delete(id, user.id);
  }

  @Query(() => [Coupon])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  storeCoupons(
    @Args('storeId') storeId: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Coupon[]> {
    return this.couponsService.findByStore(storeId, user.id);
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
  async adminToggleCoupon(@Args('id') id: string, @CurrentUser() admin: any): Promise<Coupon> {
    const result = await this.couponsService.adminToggle(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, `Cupom ${result.isActive ? 'ativado' : 'desativado'}`, `Cupom: ${result.code} (ID: ${result.id})`).catch(() => {});
    return result;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async adminDeleteCoupon(@Args('id') id: string, @CurrentUser() admin: any): Promise<boolean> {
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Cupom deletado', `Cupom ID: ${id}`).catch(() => {});
    return this.couponsService.adminDelete(id);
  }

  @Query(() => CouponValidation)
  @UseGuards(GqlAuthGuard)
  // KAN-12: a previa passa a identificar o CLIENTE.
  //
  // Antes ela chamava a validacao sem customerId, e com isso pulava duas
  // regras que o createOrder aplica: o limite de 1 uso por cliente e (agora) o
  // dono do cupom nominal. Resultado: a tela dizia "cupom aplicado" e o pedido
  // era recusado no ultimo toque — e, no caso do premio de fidelidade, a previa
  // diria "valido" para QUALQUER UM que digitasse o codigo alheio.
  async validateCoupon(
    @Args('code') code: string,
    @Args('storeId') storeId: string,
    @Args('subtotal', { type: () => Float }) subtotal: number,
    @CurrentUser() user?: any,
  ): Promise<CouponValidation> {
    const { coupon, discount } = await this.couponsService.validateAndCalculate(code, storeId, subtotal, user?.id);
    return { valid: true, discount, couponId: coupon.id, message: `Desconto de R$ ${discount.toFixed(2)} aplicado!` };
  }
}
