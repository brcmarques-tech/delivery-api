import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { VendorUser } from './entities/vendor-user.entity';
import { VendorUsersService } from './vendor-users.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole, VendorPlan } from '../common/enums';
import { PlanInfo } from '../common/plan-info.type';
import { PlatformConfigService } from '../config/platform-config.service';

@Resolver(() => VendorUser)
export class VendorUsersResolver {
  constructor(
    private vendorUsersService: VendorUsersService,
    private platformConfigService: PlatformConfigService,
  ) {}

  @Query(() => VendorUser)
  @UseGuards(GqlAuthGuard)
  meVendor(@CurrentUser() user: VendorUser): VendorUser {
    return user;
  }

  @Query(() => [VendorUser])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allVendorUsers(): Promise<VendorUser[]> {
    return this.vendorUsersService.findAll();
  }

  @Query(() => [VendorUser])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  pendingVendorApprovals(): Promise<VendorUser[]> {
    return this.vendorUsersService.findPendingApprovals();
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  approveVendorUser(@Args('id') id: string): Promise<VendorUser> {
    return this.vendorUsersService.approveUser(id);
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  rejectVendorUser(
    @Args('id') id: string,
    @Args('reason') reason: string,
  ): Promise<VendorUser> {
    return this.vendorUsersService.rejectUser(id, reason);
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  toggleVendorUserActive(@Args('id') id: string): Promise<VendorUser> {
    return this.vendorUsersService.toggleUserActive(id);
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  updateVendorPlan(
    @Args('id') id: string,
    @Args('plan', { type: () => VendorPlan }) plan: VendorPlan,
    @Args('durationMonths', { type: () => Int, defaultValue: 1 }) durationMonths: number,
  ): Promise<VendorUser> {
    return this.vendorUsersService.updateVendorPlan(id, plan, durationMonths);
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard)
  updateVendorProfile(
    @CurrentUser() user: VendorUser,
    @Args('name', { nullable: true }) name?: string,
    @Args('phone', { nullable: true }) phone?: string,
    @Args('currentPassword', { nullable: true }) currentPassword?: string,
    @Args('newPassword', { nullable: true }) newPassword?: string,
  ): Promise<VendorUser> {
    return this.vendorUsersService.updateProfile(user.id, name, phone, currentPassword, newPassword);
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard)
  async acceptVendorTerms(@CurrentUser() user: VendorUser): Promise<VendorUser> {
    return this.vendorUsersService.acceptTerms(user.id);
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard)
  async acceptSubscriptionTerms(@CurrentUser() user: VendorUser): Promise<VendorUser> {
    return this.vendorUsersService.acceptSubscriptionTerms(user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async registerVendorPushToken(
    @Args('token') token: string,
    @CurrentUser() user: VendorUser,
  ): Promise<boolean> {
    await this.vendorUsersService.updatePushToken(user.id, token);
    return true;
  }

  @Query(() => [PlanInfo])
  async availablePlans(): Promise<PlanInfo[]> {
    const plans: PlanInfo[] = [];
    for (const plan of [VendorPlan.FREE, VendorPlan.PRO, VendorPlan.PREMIUM, VendorPlan.ENTERPRISE, VendorPlan.CUSTOM]) {
      const config = await this.platformConfigService.getPlanConfig(plan);
      plans.push({ plan, ...config });
    }
    return plans;
  }
}
