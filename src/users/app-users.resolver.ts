import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AppUser } from './entities/app-user.entity';
import { AppUsersService } from './app-users.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { RegisterDelivererInput } from './dto/register-deliverer.input';

@Resolver(() => AppUser)
export class AppUsersResolver {
  constructor(private appUsersService: AppUsersService) {}

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
  approveAppUser(@Args('id') id: string): Promise<AppUser> {
    return this.appUsersService.approveUser(id);
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  rejectAppUser(
    @Args('id') id: string,
    @Args('reason') reason: string,
  ): Promise<AppUser> {
    return this.appUsersService.rejectUser(id, reason);
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  updateAppUserRole(
    @Args('id') id: string,
    @Args('role', { type: () => UserRole }) role: UserRole,
  ): Promise<AppUser> {
    return this.appUsersService.updateUserRole(id, role);
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  toggleAppUserActive(@Args('id') id: string): Promise<AppUser> {
    return this.appUsersService.toggleUserActive(id);
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  registerSuperadmin(
    @Args('name') name: string,
    @Args('email') email: string,
    @Args('password') password: string,
    @Args('phone') phone: string,
    @Args('permissions', { nullable: true }) permissions?: string,
  ): Promise<AppUser> {
    const parsedPermissions = permissions ? JSON.parse(permissions) : undefined;
    return this.appUsersService.createSuperadmin({ name, email, password, phone, permissions: parsedPermissions });
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  updateSuperadminPermissions(
    @Args('id') id: string,
    @Args('permissions') permissions: string,
  ): Promise<AppUser> {
    return this.appUsersService.updateSuperadminPermissions(id, JSON.parse(permissions));
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
  ): Promise<AppUser> {
    return this.appUsersService.updateProfile(user.id, name, phone, currentPassword, newPassword);
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard)
  async acceptAppTerms(@CurrentUser() user: AppUser): Promise<AppUser> {
    return this.appUsersService.acceptTerms(user.id);
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
