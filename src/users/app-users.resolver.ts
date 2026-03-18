import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AppUser } from './entities/app-user.entity';
import { ApprovalLog } from './entities/approval-log.entity';
import { AppUsersService } from './app-users.service';
import { MailService } from '../mail/mail.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { RegisterDelivererInput } from './dto/register-deliverer.input';

@Resolver(() => AppUser)
export class AppUsersResolver {
  constructor(
    private appUsersService: AppUsersService,
    private mailService: MailService,
  ) {}

  @Query(() => AppUser)
  @UseGuards(GqlAuthGuard)
  meApp(@CurrentUser() user: AppUser): AppUser {
    return user;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard)
  registerAsDeliverer(
    @Args('input') input: RegisterDelivererInput,
    @CurrentUser() user: AppUser,
  ): Promise<AppUser> {
    return this.appUsersService.registerAsDeliverer(user.id, input);
  }

  @Query(() => [AppUser])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allAppUsers(): Promise<AppUser[]> {
    return this.appUsersService.findAll();
  }

  @Query(() => [AppUser])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  pendingAppApprovals(): Promise<AppUser[]> {
    return this.appUsersService.findPendingApprovals();
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async approveAppUser(@Args('id') id: string, @CurrentUser() admin: AppUser): Promise<AppUser> {
    const result = await this.appUsersService.approveUser(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Usuario aprovado', `Usuario: ${result.name} (${result.email})\nRole: ${result.role}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async rejectAppUser(
    @Args('id') id: string,
    @Args('reason') reason: string,
    @CurrentUser() admin: AppUser,
  ): Promise<AppUser> {
    const result = await this.appUsersService.rejectUser(id, reason);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Usuario rejeitado', `Usuario: ${result.name} (${result.email})\nMotivo: ${reason}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async updateAppUserRole(
    @Args('id') id: string,
    @Args('role', { type: () => UserRole }) role: UserRole,
    @CurrentUser() admin: AppUser,
  ): Promise<AppUser> {
    const result = await this.appUsersService.updateUserRole(id, role);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Role de usuario alterado', `Usuario: ${result.name} (${result.email})\nNovo role: ${role}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async toggleAppUserActive(@Args('id') id: string, @CurrentUser() admin: AppUser): Promise<AppUser> {
    const result = await this.appUsersService.toggleUserActive(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, `Usuario ${result.isActive ? 'ativado' : 'desativado'}`, `Usuario: ${result.name} (${result.email})`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async registerSuperadmin(
    @Args('name') name: string,
    @Args('email') email: string,
    @Args('password') password: string,
    @Args('phone') phone: string,
    @CurrentUser() admin: AppUser,
    @Args('permissions', { nullable: true }) permissions?: string,
  ): Promise<AppUser> {
    const parsedPermissions = permissions ? JSON.parse(permissions) : undefined;
    const result = await this.appUsersService.createSuperadmin({ name, email, password, phone, permissions: parsedPermissions });
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Novo superadmin criado', `Nome: ${name}\nEmail: ${email}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async updateSuperadminPermissions(
    @Args('id') id: string,
    @Args('permissions') permissions: string,
    @CurrentUser() admin: AppUser,
  ): Promise<AppUser> {
    const result = await this.appUsersService.updateSuperadminPermissions(id, JSON.parse(permissions));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Permissoes de superadmin atualizadas', `Superadmin: ${result.name} (${result.email})\nPermissoes: ${permissions}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  updateNotificationEmail(
    @CurrentUser() user: AppUser,
    @Args('email') email: string,
  ): Promise<AppUser> {
    return this.appUsersService.updateNotificationEmail(user.id, email);
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard)
  updateAppProfile(
    @CurrentUser() user: AppUser,
    @Args('name', { nullable: true }) name?: string,
    @Args('phone', { nullable: true }) phone?: string,
    @Args('currentPassword', { nullable: true }) currentPassword?: string,
    @Args('newPassword', { nullable: true }) newPassword?: string,
    @Args('avatarUrl', { nullable: true }) avatarUrl?: string,
  ): Promise<AppUser> {
    return this.appUsersService.updateProfile(user.id, name, phone, currentPassword, newPassword, avatarUrl);
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard)
  async acceptAppTerms(@CurrentUser() user: AppUser): Promise<AppUser> {
    return this.appUsersService.acceptTerms(user.id);
  }

  @Query(() => [ApprovalLog])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  approvalLogs(): Promise<ApprovalLog[]> {
    return this.appUsersService.getApprovalLogs();
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async registerAppPushToken(
    @Args('token') token: string,
    @CurrentUser() user: AppUser,
  ): Promise<boolean> {
    await this.appUsersService.updatePushToken(user.id, token);
    return true;
  }
}
