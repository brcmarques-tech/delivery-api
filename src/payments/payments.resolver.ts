import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards, BadRequestException } from '@nestjs/common';
import { Payment } from './entities/payment.entity';
import { Subscription } from './entities/subscription.entity';
import { PaymentsService } from './payments.service';
import { SavedCard } from './entities/saved-card.entity';
import { RecipientBalance, AnticipationSimulation, AnticipationResult } from './dto/recipient-balance.type';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { UserRole, VendorPlan } from '../common/enums';

// M11 / L10: TODO — Add @Throttle() decorator from @nestjs/throttler on sensitive mutations
// (saveCard, requestAnticipation, registerRecipient) once throttler module is installed.
@Resolver(() => Payment)
export class PaymentsResolver {
  constructor(private paymentsService: PaymentsService) {}

  @Mutation(() => Payment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createPlanUpgrade(
    @Args('plan', { type: () => VendorPlan }) plan: VendorPlan,
    @Args('billingPeriod', { nullable: true, defaultValue: 'monthly' }) billingPeriod: string,
    @Args('cardToken', { nullable: true }) cardToken: string,
    @Args('paymentMethod', { nullable: true, defaultValue: 'credit_card' }) paymentMethod: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Payment> {
    return this.paymentsService.createPlanUpgrade(user, plan, billingPeriod, cardToken, paymentMethod);
  }

  @Query(() => Subscription, { nullable: true })
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  mySubscription(@CurrentUser() user: VendorUser): Promise<Subscription | null> {
    return this.paymentsService.getActiveSubscription(user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  async cancelSubscription(@CurrentUser() user: VendorUser): Promise<boolean> {
    await this.paymentsService.cancelVendorSubscription(user.id);
    return true;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  async updateSubscriptionCard(
    @Args('cardToken') cardToken: string,
    @CurrentUser() user: VendorUser,
  ): Promise<boolean> {
    await this.paymentsService.updateSubscriptionCard(user.id, cardToken);
    return true;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  async reactivateSubscription(@CurrentUser() user: VendorUser): Promise<boolean> {
    await this.paymentsService.reactivateSubscription(user.id);
    return true;
  }

  @Query(() => [Payment])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  myPayments(@CurrentUser() user: VendorUser): Promise<Payment[]> {
    return this.paymentsService.findByVendor(user.id);
  }

  @Query(() => [Payment])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allPayments(
    @Args('limit', { nullable: true, defaultValue: 100 }) limit: number,
    @Args('offset', { nullable: true, defaultValue: 0 }) offset: number,
  ): Promise<Payment[]> {
    // M4: Cap limit to prevent excessive queries
    if (limit > 500) limit = 500;
    return this.paymentsService.findAll(limit, offset);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR, UserRole.DELIVERER)
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
    // Whitelist allowed fields to prevent parameter injection
    const allowedFields = [
      'document', 'type', 'name', 'email', 'phone', 'birthdate',
      'monthlyIncome', 'professionalOccupation', 'selfDeclaredLegalRepresentative',
      'address', 'bankAccount', 'managingPartners', 'tradingName',
      'annualRevenue', 'corporationName', 'foundingDate',
    ];
    const sanitized: any = {};
    for (const key of allowedFields) {
      if (data[key] !== undefined) sanitized[key] = data[key];
    }
    data = sanitized;

    // L12: Validate required nested objects for recipient registration
    if (!data.document || typeof data.document !== 'string') {
      throw new BadRequestException('Documento (CPF/CNPJ) é obrigatório');
    }
    if (data.bankAccount) {
      const ba = data.bankAccount;
      if (!ba.holderName || !ba.bank || !ba.branchNumber || !ba.accountNumber || !ba.accountCheckDigit || !ba.type) {
        throw new BadRequestException('Dados bancários incompletos. Preencha todos os campos obrigatórios.');
      }
    }
    if (data.address) {
      const addr = data.address;
      if (!addr.street || !addr.streetNumber || !addr.neighborhood || !addr.city || !addr.state || !addr.zipCode) {
        throw new BadRequestException('Endereço incompleto. Preencha todos os campos obrigatórios.');
      }
    }

    if (user.userType === 'vendor') {
      await this.paymentsService.registerVendorRecipient(user.id, data);
    } else {
      await this.paymentsService.registerDelivererRecipient(user.id, data);
    }
    return true;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR, UserRole.DELIVERER)
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
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR, UserRole.DELIVERER)
  async myBalance(@CurrentUser() user: any): Promise<RecipientBalance> {
    const recipientId = user.pagarmeRecipientId;
    if (!recipientId) {
      return { availableAmount: 0, waitingFundsAmount: 0, transferredAmount: 0, autoAnticipationEnabled: false };
    }
    try {
      return await this.paymentsService.getRecipientBalance(recipientId);
    } catch {
      // If balance API fails, return zeros with error indication via GraphQL
      throw new BadRequestException('Não foi possível consultar o saldo. Tente novamente.');
    }
  }

  @Query(() => AnticipationSimulation)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR, UserRole.DELIVERER)
  async simulateAnticipation(@CurrentUser() user: any): Promise<AnticipationSimulation> {
    const recipientId = user.pagarmeRecipientId;
    if (!recipientId) {
      return { originalAmount: 0, anticipatedAmount: 0, fee: 0, feePercentage: 0 };
    }
    return this.paymentsService.simulateAnticipation(recipientId);
  }

  @Mutation(() => AnticipationResult)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR, UserRole.DELIVERER)
  async requestAnticipation(@CurrentUser() user: any): Promise<AnticipationResult> {
    const recipientId = user.pagarmeRecipientId;
    if (!recipientId) {
      throw new BadRequestException('Você precisa cadastrar seus dados bancários primeiro');
    }
    return this.paymentsService.requestAnticipation(recipientId);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR, UserRole.DELIVERER)
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
