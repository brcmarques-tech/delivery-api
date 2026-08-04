import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { VendorUser } from './entities/vendor-user.entity';
import { VendorUsersService } from './vendor-users.service';
import { MailService } from '../mail/mail.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permission } from '../auth/decorators/permission.decorator';
import { UserRole, VendorPlan } from '../common/enums';
import { PlanInfo } from '../common/plan-info.type';
import { AppUser } from './entities/app-user.entity';
import { PlatformConfigService } from '../config/platform-config.service';

@Resolver(() => VendorUser)
export class VendorUsersResolver {
  constructor(
    private vendorUsersService: VendorUsersService,
    private mailService: MailService,
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
  @Permission('approvals')
  async approveVendorUser(@Args('id') id: string, @CurrentUser() admin: any): Promise<VendorUser> {
    const result = await this.vendorUsersService.approveUser(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Vendedor aprovado', `Vendedor: ${result.name} (${result.email})`).catch(() => {});
    return result;
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('approvals')
  async rejectVendorUser(
    @Args('id') id: string,
    @Args('reason') reason: string,
    @CurrentUser() admin: any,
  ): Promise<VendorUser> {
    const result = await this.vendorUsersService.rejectUser(id, reason);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Vendedor rejeitado', `Vendedor: ${result.name} (${result.email})\nMotivo: ${reason}`).catch(() => {});
    return result;
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('users')
  async toggleVendorUserActive(@Args('id') id: string, @CurrentUser() admin: any): Promise<VendorUser> {
    const result = await this.vendorUsersService.toggleUserActive(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, `Vendedor ${result.isActive ? 'ativado' : 'desativado'}`, `Vendedor: ${result.name} (${result.email})`).catch(() => {});
    return result;
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('plans')
  async updateVendorPlan(
    @Args('id') id: string,
    @Args('plan', { type: () => VendorPlan }) plan: VendorPlan,
    @Args('durationMonths', { type: () => Int, defaultValue: 1 }) durationMonths: number,
    @CurrentUser() admin: any,
  ): Promise<VendorUser> {
    const result = await this.vendorUsersService.updateVendorPlan(id, plan, durationMonths);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Plano de vendedor atualizado', `Vendedor: ${result.name} (${result.email})\nPlano: ${plan}\nDuracao: ${durationMonths} mes(es)`).catch(() => {});
    return result;
  }

  @Mutation(() => VendorUser)
  @UseGuards(GqlAuthGuard)
  updateVendorProfile(
    @CurrentUser() user: VendorUser,
    @Args('name', { nullable: true }) name?: string,
    @Args('phone', { nullable: true }) phone?: string,
    @Args('currentPassword', { nullable: true }) currentPassword?: string,
    @Args('newPassword', { nullable: true }) newPassword?: string,
    @Args('email', { nullable: true }) email?: string,
    @Args('cpf', { nullable: true }) cpf?: string,
  ): Promise<VendorUser> {
    return this.vendorUsersService.updateProfile(user.id, name, phone, currentPassword, newPassword, email, cpf);
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
