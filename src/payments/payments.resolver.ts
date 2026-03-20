import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards, BadRequestException } from '@nestjs/common';
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';
import { SavedCard } from './dto/saved-card.type';
import { RecipientBalance, AnticipationSimulation, AnticipationResult } from './dto/recipient-balance.type';
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
    let data: any;
    try {
      data = JSON.parse(recipientData);
    } catch {
      throw new BadRequestException('Dados inválidos. Verifique o formato JSON.');
    }
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

  // ─── Recipient Balance & Anticipation ──────────────────────────────

  @Query(() => RecipientBalance)
  @UseGuards(GqlAuthGuard)
  async myBalance(@CurrentUser() user: any): Promise<RecipientBalance> {
    const recipientId = user.pagarmeRecipientId;
    if (!recipientId) {
      return { availableAmount: 0, waitingFundsAmount: 0, transferredAmount: 0 };
    }
    return this.paymentsService.getRecipientBalance(recipientId);
  }

  @Query(() => AnticipationSimulation)
  @UseGuards(GqlAuthGuard)
  async simulateAnticipation(@CurrentUser() user: any): Promise<AnticipationSimulation> {
    const recipientId = user.pagarmeRecipientId;
    if (!recipientId) {
      return { originalAmount: 0, anticipatedAmount: 0, fee: 0, feePercentage: 0 };
    }
    return this.paymentsService.simulateAnticipation(recipientId);
  }

  @Mutation(() => AnticipationResult)
  @UseGuards(GqlAuthGuard)
  async requestAnticipation(@CurrentUser() user: any): Promise<AnticipationResult> {
    const recipientId = user.pagarmeRecipientId;
    if (!recipientId) {
      throw new BadRequestException('Você precisa cadastrar seus dados bancários primeiro');
    }
    return this.paymentsService.requestAnticipation(recipientId);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async toggleAutoAnticipation(
    @Args('enabled') enabled: boolean,
    @CurrentUser() user: any,
  ): Promise<boolean> {
    const recipientId = user.pagarmeRecipientId;
    if (!recipientId) {
      throw new BadRequestException('Você precisa cadastrar seus dados bancários primeiro');
    }
    return this.paymentsService.updateRecipientAnticipationSettings(recipientId, enabled);
  }
}
