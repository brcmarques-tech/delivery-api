import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';
import { SavedCard } from './dto/saved-card.type';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { AppUser } from '../users/entities/app-user.entity';
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
    @CurrentUser() user: VendorUser,
  ): Promise<Payment> {
    return this.paymentsService.createPlanUpgrade(user, plan, billingPeriod);
  }

  @Query(() => [Payment])
  @UseGuards(GqlAuthGuard)
  myPayments(@CurrentUser() user: VendorUser): Promise<Payment[]> {
    return this.paymentsService.findByVendor(user.id);
  }

  @Query(() => [Payment])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allPayments(): Promise<Payment[]> {
    return this.paymentsService.findAll();
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async registerRecipient(
    @CurrentUser() user: any,
    @Args('recipientData') recipientData: string,
  ): Promise<boolean> {
    const data = JSON.parse(recipientData);
    if (user.userType === 'vendor') {
      await this.paymentsService.registerVendorRecipient(user.id, data);
    } else {
      await this.paymentsService.registerDelivererRecipient(user.id, data);
    }
    return true;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async disconnectPayment(@CurrentUser() user: any): Promise<boolean> {
    if (user.userType === 'vendor') {
      await this.paymentsService.disconnectVendor(user.id);
    } else {
      await this.paymentsService.disconnectApp(user.id);
    }
    return true;
  }

  // ─── Saved Cards (CUSTOMER) ──────────────────────────────────────────

  @Mutation(() => SavedCard)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.DELIVERER)
  async saveCard(
    @Args('token') token: string,
    @CurrentUser() user: AppUser,
  ): Promise<SavedCard> {
    return this.paymentsService.saveCard(user.id, token);
  }

  @Query(() => [SavedCard])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.DELIVERER)
  async myCards(@CurrentUser() user: AppUser): Promise<SavedCard[]> {
    return this.paymentsService.listCards(user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.DELIVERER)
  async deleteCard(
    @Args('cardId') cardId: string,
    @CurrentUser() user: AppUser,
  ): Promise<boolean> {
    return this.paymentsService.deleteCard(user.id, cardId);
  }
}
