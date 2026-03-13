import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole, VendorPlan } from '../common/enums';

@Resolver(() => Payment)
export class PaymentsResolver {
  constructor(private paymentsService: PaymentsService) {}

  @Mutation(() => Payment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createPlanUpgrade(
    @Args('plan', { type: () => VendorPlan }) plan: VendorPlan,
    @Args('billingPeriod', { nullable: true, defaultValue: 'monthly' }) billingPeriod: string,
    @CurrentUser() user: User,
  ): Promise<Payment> {
    return this.paymentsService.createPlanUpgrade(user, plan, billingPeriod);
  }

  @Query(() => [Payment])
  @UseGuards(GqlAuthGuard)
  myPayments(@CurrentUser() user: User): Promise<Payment[]> {
    return this.paymentsService.findByUser(user.id);
  }

  @Query(() => [Payment])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allPayments(): Promise<Payment[]> {
    return this.paymentsService.findAll();
  }

  @Query(() => String)
  @UseGuards(GqlAuthGuard)
  mpConnectUrl(
    @CurrentUser() user: User,
    @Args('source', { nullable: true, defaultValue: 'web' }) source: string,
  ): string {
    return this.paymentsService.getMpConnectUrl(user.id, source);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async disconnectMercadoPago(@CurrentUser() user: User): Promise<boolean> {
    await this.paymentsService.disconnectMp(user.id);
    return true;
  }
}
