import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole, VendorPlan } from '../common/enums';
import { RegisterDelivererInput } from './dto/register-deliverer.input';
import { PlanInfo } from '../common/plan-info.type';
import { PLAN_CONFIGS } from '../common/plan-config';

@Resolver(() => User)
export class UsersResolver {
  constructor(private usersService: UsersService) {}

  @Query(() => User)
  @UseGuards(GqlAuthGuard)
  me(@CurrentUser() user: User): User {
    return user;
  }

  @Mutation(() => User)
  @UseGuards(GqlAuthGuard)
  registerAsDeliverer(
    @Args('input') input: RegisterDelivererInput,
    @CurrentUser() user: User,
  ): Promise<User> {
    return this.usersService.registerAsDeliverer(user.id, input);
  }

  @Query(() => [User])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allUsers(): Promise<User[]> {
    return this.usersService.findAll();
  }

  @Query(() => [User])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  pendingApprovals(): Promise<User[]> {
    return this.usersService.findPendingApprovals();
  }

  @Mutation(() => User)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  approveUser(@Args('id') id: string): Promise<User> {
    return this.usersService.approveUser(id);
  }

  @Mutation(() => User)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  rejectUser(
    @Args('id') id: string,
    @Args('reason') reason: string,
  ): Promise<User> {
    return this.usersService.rejectUser(id, reason);
  }

  @Mutation(() => User)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  updateUserRole(
    @Args('id') id: string,
    @Args('role', { type: () => UserRole }) role: UserRole,
  ): Promise<User> {
    return this.usersService.updateUserRole(id, role);
  }

  @Mutation(() => User)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  toggleUserActive(@Args('id') id: string): Promise<User> {
    return this.usersService.toggleUserActive(id);
  }

  @Mutation(() => User)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  updateVendorPlan(
    @Args('id') id: string,
    @Args('plan', { type: () => VendorPlan }) plan: VendorPlan,
    @Args('durationMonths', { type: () => Int, defaultValue: 1 }) durationMonths: number,
  ): Promise<User> {
    return this.usersService.updateVendorPlan(id, plan, durationMonths);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async registerPushToken(
    @Args('token') token: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    await this.usersService.updatePushToken(user.id, token);
    return true;
  }

  @Query(() => [PlanInfo])
  availablePlans(): PlanInfo[] {
    return Object.entries(PLAN_CONFIGS).map(([plan, config]) => ({
      plan: plan as VendorPlan,
      ...config,
    }));
  }
}
