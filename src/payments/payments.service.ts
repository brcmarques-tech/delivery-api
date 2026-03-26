import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Payment } from './entities/payment.entity';
import { SavedCard } from './entities/saved-card.entity';
import { WebhookEvent } from './entities/webhook-event.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { Store } from '../stores/entities/store.entity';
import { Order } from '../orders/entities/order.entity';
import { Promotion } from '../promotions/entities/promotion.entity';
import { AppUsersService } from '../users/app-users.service';
import { VendorUsersService } from '../users/vendor-users.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VendorPlan, OrderStatus } from '../common/enums';
import { PLAN_CONFIGS } from '../common/plan-config';
import { PubSub } from 'graphql-subscriptions';
import { PUB_SUB } from '../pubsub/pubsub.module';

// L5: Centralized descriptor constant
const STATEMENT_DESCRIPTOR = 'BCMTECH';

@Injectable()
export class PaymentsService implements OnModuleDestroy {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly pagarmeBaseUrl = 'https://api.pagar.me/core/v5';
  private readonly pagarmeAuthHeader: string;

  // L7: Format phone for Pagar.me API — handles country code stripping for 12-13 digit numbers
  private formatPhoneForPagarme(phone?: string): { country_code: string; area_code: string; number: string } | null {
    let digits = phone?.replace(/\D/g, '') || '';
    if (digits.length < 10) return null; // need at least DDD + 8 digits
    // Strip leading country code 55 for 12-13 digit numbers (55 + DDD + number)
    if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
      digits = digits.substring(2);
    }
    const areaCode = digits.substring(0, 2);
    const number = digits.substring(2);
    return { country_code: '55', area_code: areaCode, number };
  }

  // M7: Build billing address — Pagar.me V5 requires separate fields (street, number, neighborhood)
  private buildBillingAddress(order: Order, store: Store): { street: string; number: string; neighborhood: string; zip_code: string; city: string; state: string; country: string } {
    // Parse delivery address if available (format: "Rua X, 123 - Bairro, Cidade")
    const addr = order.deliveryAddress;
    // Try to extract zip from customer data if available
    const customerZip = (order as any).customer?.zipCode?.replace(/\D/g, '')
      || (order as any).deliveryZipCode?.replace(/\D/g, '');
    if (addr) {
      const parts = addr.split(',').map(p => p.trim());
      const street = parts[0] || 'Rua Nao Informada';
      const numberAndNeighborhood = parts[1]?.split('-').map(p => p.trim()) || [];
      const num = numberAndNeighborhood[0] || 'SN';
      const neighborhood = numberAndNeighborhood[1] || parts[2] || 'Centro';
      return {
        street,
        number: num,
        neighborhood,
        zip_code: customerZip || store?.zipCode?.replace(/\D/g, '') || '00000000',
        city: parts[parts.length - 1] || store?.city || 'Nao Informada',
        state: store?.state || 'RS',
        country: 'BR',
      };
    }
    // Fallback to store address if no delivery address (e.g. pickup)
    return {
      street: store?.street || 'Rua Nao Informada',
      number: store?.number || 'SN',
      neighborhood: store?.neighborhood || 'Centro',
      zip_code: store?.zipCode?.replace(/\D/g, '') || '00000000',
      city: store?.city || 'Nao Informada',
      state: store?.state || 'RS',
      country: 'BR',
    };
  }

  constructor(
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    @InjectRepository(SavedCard)
    private savedCardsRepository: Repository<SavedCard>,
    @InjectRepository(WebhookEvent)
    private webhookEventsRepository: Repository<WebhookEvent>,
    private configService: ConfigService,
    private httpService: HttpService,
    @Inject(forwardRef(() => AppUsersService))
    private appUsersService: AppUsersService,
    @Inject(forwardRef(() => VendorUsersService))
    private vendorUsersService: VendorUsersService,
    private platformConfigService: PlatformConfigService,
    private whatsAppService: WhatsAppService,
    private notificationsService: NotificationsService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {
    const secretKey = this.configService.get('PAGARME_SECRET_KEY') || '';
    this.pagarmeAuthHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');
  }

  // L4: Properly clean up interval on module destroy
  onModuleDestroy() {
    if (this.webhookCleanupInterval) {
      clearInterval(this.webhookCleanupInterval);
    }
  }

  // ─── Pagar.me HTTP helpers ────────────────────────────────────────────

  private async pagarmePost<T = any>(path: string, body: any): Promise<T> {
    const response = await this.httpService.axiosRef.post(
      `${this.pagarmeBaseUrl}${path}`,
      body,
      {
        headers: {
          'Authorization': this.pagarmeAuthHeader,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  private async pagarmeGet<T = any>(path: string): Promise<T> {
    const response = await this.httpService.axiosRef.get(
      `${this.pagarmeBaseUrl}${path}`,
      {
        headers: {
          'Authorization': this.pagarmeAuthHeader,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  private async pagarmePut<T = any>(path: string, body: any): Promise<T> {
    const response = await this.httpService.axiosRef.put(
      `${this.pagarmeBaseUrl}${path}`,
      body,
      {
        headers: {
          'Authorization': this.pagarmeAuthHeader,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  private async pagarmePatch<T = any>(path: string, body: any): Promise<T> {
    const response = await this.httpService.axiosRef.patch(
      `${this.pagarmeBaseUrl}${path}`,
      body,
      {
        headers: {
          'Authorization': this.pagarmeAuthHeader,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  private async pagarmeDelete<T = any>(path: string): Promise<T> {
    const response = await this.httpService.axiosRef.delete(
      `${this.pagarmeBaseUrl}${path}`,
      {
        headers: {
          'Authorization': this.pagarmeAuthHeader,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  // ─── Pagar.me error translation ──────────────────────────────────────

  private translatePagarmeError(errorData: any): string {
    if (!errorData?.errors) {
      return errorData?.message || 'Erro ao processar no Pagar.me. Tente novamente.';
    }

    const translations: Record<string, string> = {
      // register_information - individual
      'The document field is required': 'CPF é obrigatório',
      'The name field is required': 'Nome é obrigatório',
      'The email field is required': 'Email é obrigatório',
      'The birthdate field is required': 'Data de nascimento é obrigatória',
      'The monthly_income field is required': 'Renda mensal é obrigatória',
      'The professional_occupation field is required': 'Profissão é obrigatória',
      'The phone_numbers field is required': 'Telefone é obrigatório',
      // register_information - corporation
      'The company_name field is required': 'Razão social é obrigatória',
      'The trading_name field is required': 'Nome fantasia é obrigatório',
      'The annual_revenue field is required': 'Faturamento anual é obrigatório',
      // address
      'The street field is required': 'Rua é obrigatória',
      'The street_number field is required': 'Número é obrigatório',
      'The neighborhood field is required': 'Bairro é obrigatório',
      'The city field is required': 'Cidade é obrigatória',
      'The state field is required': 'Estado é obrigatório',
      'The zip_code field is required': 'CEP é obrigatório',
      // bank account
      'The holder_name field is required': 'Nome do titular é obrigatório',
      'The bank field is required': 'Banco é obrigatório',
      'The branch_number field is required': 'Agência é obrigatória',
      'The account_number field is required': 'Conta é obrigatória',
      'The account_check_digit field is required': 'Dígito da conta é obrigatório',
      // uniqueness
      'External ID must be unique': 'Conta já registrada anteriormente',
    };

    const messages: string[] = [];
    for (const field of Object.keys(errorData.errors)) {
      const fieldErrors = errorData.errors[field];
      if (Array.isArray(fieldErrors)) {
        for (const msg of fieldErrors) {
          const translated = translations[msg];
          if (translated) {
            messages.push(translated);
          } else if (msg.includes('is required')) {
            const fieldName = field.split('.').pop()?.replace(/_/g, ' ') || field;
            messages.push(`Campo "${fieldName}" é obrigatório`);
          } else if (msg.includes('is invalid') || msg.includes('is not valid')) {
            const fieldName = field.split('.').pop()?.replace(/_/g, ' ') || field;
            messages.push(`Campo "${fieldName}" é inválido`);
          } else if (msg.includes('must be unique')) {
            messages.push('Conta já registrada anteriormente');
          } else {
            messages.push(msg);
          }
        }
      }
    }

    return messages.length > 0 ? messages.join('. ') + '.' : 'Erro de validação no Pagar.me.';
  }

  // ─── Recipients (Recebedores) ─────────────────────────────────────────

  async createRecipient(data: {
    code: string;
    name: string;
    email: string;
    document: string;
    type: 'individual' | 'corporation';
    birthdate?: string;
    monthlyIncome?: number;
    professionalOccupation?: string;
    motherName?: string;
    phone: { ddd: string; number: string };
    address: {
      street: string;
      streetNumber: string;
      neighborhood: string;
      city: string;
      state: string;
      zipCode: string;
      complementary?: string;
      referencePoint?: string;
    };
    bankAccount: {
      holderName: string;
      bank: string;
      branchNumber: string;
      branchCheckDigit?: string;
      accountNumber: string;
      accountCheckDigit: string;
      type: 'checking' | 'savings';
    };
    // Corporation fields
    companyName?: string;
    tradingName?: string;
    annualRevenue?: number;
    corporationType?: string;
    foundingDate?: string;
    managingPartners?: Array<{
      name: string;
      email: string;
      document: string;
      motherName?: string;
      birthdate: string;
      monthlyIncome: number;
      professionalOccupation: string;
      selfDeclaredLegalRepresentative: boolean;
      phone: { ddd: string; number: string };
      address: {
        street: string;
        streetNumber: string;
        neighborhood: string;
        city: string;
        state: string;
        zipCode: string;
      };
    }>;
  }): Promise<any> {
    const registerInfo: any = {
      email: data.email,
      document: data.document.replace(/\D/g, ''),
      type: data.type,
      phone_numbers: [
        { ddd: data.phone.ddd, number: data.phone.number, type: 'mobile' },
      ],
    };

    if (data.type === 'individual') {
      registerInfo.name = data.name;
      // Pagar.me expects DD/MM/YYYY format
      const [y, m, d] = (data.birthdate || '').split('-');
      registerInfo.birthdate = y && m && d ? `${d}/${m}/${y}` : data.birthdate;
      registerInfo.monthly_income = data.monthlyIncome || 300000; // R$ 3.000,00 em centavos
      registerInfo.professional_occupation = data.professionalOccupation || 'Autônomo';
      if (data.motherName) registerInfo.mother_name = data.motherName;
      registerInfo.address = {
        street: data.address.street,
        street_number: data.address.streetNumber,
        complementary: data.address.complementary || 'N/A',
        reference_point: data.address.referencePoint || 'N/A',
        neighborhood: data.address.neighborhood,
        city: data.address.city,
        state: data.address.state,
        zip_code: data.address.zipCode.replace(/\D/g, ''),
      };
    } else {
      registerInfo.company_name = data.companyName;
      registerInfo.trading_name = data.tradingName;
      registerInfo.annual_revenue = data.annualRevenue;
      if (data.corporationType) registerInfo.corporation_type = data.corporationType;
      if (data.foundingDate) registerInfo.founding_date = data.foundingDate;
      registerInfo.main_address = {
        street: data.address.street,
        street_number: data.address.streetNumber,
        complementary: data.address.complementary || 'N/A',
        reference_point: data.address.referencePoint || 'N/A',
        neighborhood: data.address.neighborhood,
        city: data.address.city,
        state: data.address.state,
        zip_code: data.address.zipCode.replace(/\D/g, ''),
      };
      if (data.managingPartners) {
        registerInfo.managing_partners = data.managingPartners.map((p) => ({
          name: p.name,
          email: p.email,
          document: p.document.replace(/\D/g, ''),
          type: 'individual',
          mother_name: p.motherName || '',
          birthdate: (() => { const [y2, m2, d2] = (p.birthdate || '').split('-'); return y2 && m2 && d2 ? `${d2}/${m2}/${y2}` : p.birthdate; })(),
          monthly_income: p.monthlyIncome || 300000,
          professional_occupation: p.professionalOccupation || 'Empresário',
          self_declared_legal_representative: p.selfDeclaredLegalRepresentative,
          phone_numbers: [{ ddd: p.phone.ddd, number: p.phone.number, type: 'mobile' }],
          address: {
            street: p.address.street,
            street_number: p.address.streetNumber,
            neighborhood: p.address.neighborhood,
            city: p.address.city,
            state: p.address.state,
            zip_code: p.address.zipCode.replace(/\D/g, ''),
          },
        }));
      }
    }

    const body = {
      code: data.code,
      register_information: registerInfo,
      default_bank_account: {
        holder_name: data.bankAccount.holderName,
        holder_type: data.type,
        holder_document: data.document.replace(/\D/g, ''),
        bank: data.bankAccount.bank,
        branch_number: data.bankAccount.branchNumber,
        ...(data.bankAccount.branchCheckDigit ? { branch_check_digit: data.bankAccount.branchCheckDigit } : {}),
        account_number: data.bankAccount.accountNumber,
        account_check_digit: data.bankAccount.accountCheckDigit,
        type: data.bankAccount.type,
      },
      transfer_settings: {
        transfer_enabled: true,
        transfer_interval: 'daily',
        transfer_day: 0,
      },
      automatic_anticipation_settings: {
        enabled: false,
      },
    };

    try {
      this.logger.log(`Creating recipient: ${data.code}`);
      const result = await this.pagarmePost('/recipients', body);
      this.logger.log(`Recipient created: ${result.id} (code: ${data.code})`);
      return result;
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Failed to create recipient: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(this.translatePagarmeError(errorData));
    }
  }

  async updateRecipient(recipientId: string, data: any): Promise<any> {
    const registerInfo: any = {
      email: data.email,
      document: data.document.replace(/\D/g, ''),
      type: data.type,
      phone_numbers: [
        { ddd: data.phone.ddd, number: data.phone.number, type: 'mobile' },
      ],
    };

    if (data.type === 'individual') {
      registerInfo.name = data.name;
      const [y, m, d] = (data.birthdate || '').split('-');
      registerInfo.birthdate = y && m && d ? `${d}/${m}/${y}` : data.birthdate;
      registerInfo.monthly_income = data.monthlyIncome || 300000;
      registerInfo.professional_occupation = data.professionalOccupation || 'Autônomo';
      if (data.address) {
        registerInfo.address = {
          street: data.address.street,
          street_number: data.address.streetNumber,
          complementary: data.address.complementary || 'N/A',
          reference_point: data.address.referencePoint || 'N/A',
          neighborhood: data.address.neighborhood,
          city: data.address.city,
          state: data.address.state,
          zip_code: data.address.zipCode.replace(/\D/g, ''),
        };
      }
    } else if (data.type === 'corporation') {
      if (data.companyName) registerInfo.company_name = data.companyName;
      if (data.tradingName) registerInfo.trading_name = data.tradingName;
      if (data.annualRevenue) registerInfo.annual_revenue = data.annualRevenue;
      if (data.address) {
        registerInfo.main_address = {
          street: data.address.street,
          street_number: data.address.streetNumber,
          complementary: data.address.complementary || 'N/A',
          reference_point: data.address.referencePoint || 'N/A',
          neighborhood: data.address.neighborhood,
          city: data.address.city,
          state: data.address.state,
          zip_code: data.address.zipCode.replace(/\D/g, ''),
        };
      }
    }

    const body: any = {
      register_information: registerInfo,
      default_bank_account: {
        holder_name: data.bankAccount.holderName,
        holder_type: data.type,
        holder_document: data.document.replace(/\D/g, ''),
        bank: data.bankAccount.bank,
        branch_number: data.bankAccount.branchNumber,
        ...(data.bankAccount.branchCheckDigit ? { branch_check_digit: data.bankAccount.branchCheckDigit } : {}),
        account_number: data.bankAccount.accountNumber,
        account_check_digit: data.bankAccount.accountCheckDigit,
        type: data.bankAccount.type,
      },
    };

    try {
      this.logger.log(`Updating recipient: ${recipientId}`);
      const result = await this.pagarmePut(`/recipients/${recipientId}`, body);
      this.logger.log(`Recipient updated: ${recipientId}`);
      return result;
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Failed to update recipient: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(this.translatePagarmeError(errorData));
    }
  }

  async getRecipient(recipientId: string): Promise<any> {
    return this.pagarmeGet(`/recipients/${recipientId}`);
  }

  // ─── Customers ────────────────────────────────────────────────────────

  private async getOrCreatePagarmeCustomer(user: { name: string; email: string; cpf?: string; phone?: string }): Promise<string | undefined> {
    try {
      const phone = this.formatPhoneForPagarme(user.phone);

      const customerBody: any = {
        name: user.name,
        email: user.email,
        type: 'individual',
        document: user.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        ...(phone ? { phones: { mobile_phone: phone } } : {}),
      };

      const result = await this.pagarmePost('/customers', customerBody);
      return result.id;
    } catch (err: any) {
      this.logger.warn(`Failed to create Pagar.me customer: ${err.response?.data?.message || err.message}`);
      return undefined;
    }
  }

  async ensureCustomer(user: AppUser): Promise<string> {
    if (user.pagarmeCustomerId) return user.pagarmeCustomerId;

    const customerId = await this.getOrCreatePagarmeCustomer(user);
    if (!customerId) throw new BadRequestException('Nao foi possivel criar cliente no Pagar.me');

    await this.appUsersService.updatePagarmeCustomerId(user.id, customerId);
    return customerId;
  }

  // ─── Saved Cards ────────────────────────────────────────────────────

  async saveCard(userId: string, cardToken: string): Promise<SavedCard> {
    const user = await this.appUsersService.findById(userId);
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    const customerId = await this.ensureCustomer(user);

    try {
      const result = await this.pagarmePost(`/customers/${customerId}/cards`, { token: cardToken });
      const card = this.savedCardsRepository.create({
        id: result.id,
        userId,
        lastFourDigits: result.last_four_digits,
        brand: result.brand,
        holderName: result.holder_name,
        expMonth: result.exp_month,
        expYear: result.exp_year,
      });
      return this.savedCardsRepository.save(card);
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Failed to save card: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao salvar cartao');
    }
  }

  async listCards(userId: string): Promise<SavedCard[]> {
    // Primary source: our database
    const localCards = await this.savedCardsRepository.find({ where: { userId } });
    if (localCards.length > 0) return localCards;

    // Fallback: fetch from Pagar.me charges (for cards saved before DB tracking)
    const user = await this.appUsersService.findById(userId);
    if (!user?.pagarmeCustomerId) return [];

    try {
      const result = await this.pagarmeGet(
        `/charges?customer_id=${user.pagarmeCustomerId}&payment_method=credit_card&page=1&size=20`,
      );
      const charges = result.data || result;
      const seen = new Set<string>();
      const cards: SavedCard[] = [];

      for (const charge of (Array.isArray(charges) ? charges : [])) {
        const c = charge.last_transaction?.card;
        if (c?.id && c.status === 'active' && !seen.has(c.id)) {
          seen.add(c.id);
          const card = this.savedCardsRepository.create({
            id: c.id,
            userId,
            lastFourDigits: c.last_four_digits,
            brand: c.brand,
            holderName: c.holder_name,
            expMonth: c.exp_month,
            expYear: c.exp_year,
          });
          cards.push(card);
        }
      }

      // Persist discovered cards so future lookups hit the DB
      if (cards.length > 0) {
        await this.savedCardsRepository.save(cards);
      }
      return cards;
    } catch (err: any) {
      this.logger.warn(`Failed to list cards from charges: ${err.response?.data?.message || err.message}`);
      return [];
    }
  }

  async deleteCard(userId: string, cardId: string): Promise<boolean> {
    const user = await this.appUsersService.findById(userId);
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    // Validate card belongs to user
    const card = await this.savedCardsRepository.findOne({ where: { id: cardId, userId } });
    if (!card) {
      throw new BadRequestException('Cartao nao encontrado na sua conta');
    }

    // Delete from Pagar.me (best-effort) and our DB
    if (user.pagarmeCustomerId) {
      try {
        await this.pagarmeDelete(`/customers/${user.pagarmeCustomerId}/cards/${cardId}`);
      } catch (err: any) {
        this.logger.warn(`Failed to delete card from Pagarme: ${err.response?.data?.message || err.message}`);
      }
    }
    await this.savedCardsRepository.remove(card);
    return true;
  }

  // ─── Direct Charge (saved card) ────────────────────────────────────

  async createOrderDirectCharge(order: Order, customer: AppUser, cardId?: string, cardToken?: string): Promise<{ pagarmeOrderId: string; status: string; chargeId?: string }> {
    const store = order.store;

    const customerId = await this.ensureCustomer(customer);
    const totalCents = Math.round(Number(order.total) * 100);

    const phone = this.formatPhoneForPagarme(customer.phone);

    // Use customer's delivery address for billing, not the store's address
    const billingAddress = this.buildBillingAddress(order, store);

    // Unique code per attempt to avoid Pagar.me duplicate rejection (max 52 chars)
    const uniqueCode = `${order.id}-${Date.now()}`;

    // Pré-autorização: capture: false — segura o limite mas não cobra
    // billing_address: quando card_id é usado, o Pagar.me já tem o billing do cartão salvo
    // quando card_token é usado, o billing veio na tokenização feita pelo app
    const orderBody: any = {
      code: uniqueCode,
      items: [
        {
          amount: totalCents,
          description: `Pedido ${order.orderNumber}`.substring(0, 256),
          quantity: 1,
          code: uniqueCode,
        },
      ],
      customer: {
        id: customerId,
        name: customer.name,
        email: customer.email,
        type: 'individual',
        document: customer.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        ...(phone ? { phones: { mobile_phone: phone } } : {}),
        address: billingAddress,
      },
      payments: [
        {
          payment_method: 'credit_card',
          credit_card: {
            installments: 1,
            statement_descriptor: STATEMENT_DESCRIPTOR,
            capture: false,
            ...(cardToken ? { card_token: cardToken } : { card_id: cardId }),
            card: {
              billing_address: billingAddress,
            },
          },
        },
      ],
      metadata: {
        order_id: order.id,
        order_number: order.orderNumber,
      },
      closed: true,
    };

    try {
      const result = await this.pagarmePost('/orders', orderBody);
      const charge = result.charges?.[0];
      const chargeId = charge?.id;
      const status = charge?.status || result.status || 'pending';
      this.logger.log(
        `Pagar.me pre-auth for ${order.orderNumber} | total: ${order.total} | pagarme_order: ${result.id} | charge: ${chargeId} | status: ${status}`,
      );
      // Detect antifraud reproval: acquirer approved but antifraud blocked
      const antifraudResponse = charge?.last_transaction?.antifraud_response;
      const acquirerMessage = charge?.last_transaction?.acquirer_message || '';
      if (
        (status === 'failed' || status === 'refused' || status === 'canceled') &&
        antifraudResponse?.status === 'reproved' &&
        acquirerMessage.toLowerCase().includes('aprovad')
      ) {
        this.logger.warn(
          `Pagar.me antifraud reproved for ${order.orderNumber} | charge: ${chargeId} | acquirer: "${acquirerMessage}" | antifraud score: ${antifraudResponse.score}`,
        );
        return { pagarmeOrderId: result.id, status: 'antifraud_review', chargeId };
      }
      if (status === 'failed' || status === 'refused' || status === 'canceled') {
        const reason = acquirerMessage || charge?.last_transaction?.gateway_response?.errors?.[0]?.message || 'Pagamento recusado';
        throw new BadRequestException(`Pagamento recusado: ${reason}`);
      }
      return { pagarmeOrderId: result.id, status, chargeId };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me pre-auth failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(
        errorData?.message || 'Erro ao pre-autorizar cartao',
      );
    }
  }

  // ─── Order Checkout (Credit Card via Pagar.me) ─────────────────────────

  // M3: Simplified — uses only payment link (no orphaned Pagar.me order)
  async createOrderCheckout(order: Order, customer: AppUser): Promise<{ checkoutUrl: string; preferenceId: string }> {
    await this.ensureCustomer(customer);

    // No split at payment time — all money goes to platform.
    // Transfers to vendor/deliverer happen after delivery is confirmed.

    const totalCents = Math.round(Number(order.total) * 100);

    try {
      // Create hosted checkout page directly via payment link (no separate order)
      const checkoutUrl = await this.createPaymentLink(order, totalCents, []);

      this.logger.log(
        `Pagar.me payment link created for ${order.orderNumber} | total: ${order.total}`,
      );

      // Use a placeholder preferenceId since we no longer create a separate Pagar.me order
      return { checkoutUrl, preferenceId: `link-${order.id}-${Date.now()}` };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me checkout failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(
        errorData?.message || 'Erro ao criar pagamento no Pagar.me',
      );
    }
  }

  // ─── Order PIX ─────────────────────────────────────────────────────────

  async createOrderPix(order: Order, customer: AppUser): Promise<{ checkoutUrl: string; preferenceId: string; qrCode?: string; qrCodeUrl?: string }> {
    const store = order.store;
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    const platformRecipientId = this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID');

    this.logger.log(`PIX split check: vendorRecipientId=${vendorRecipientId || 'NULL'} platformRecipientId=${platformRecipientId || 'NULL'} storeOwner=${store?.owner?.email || 'NULL'}`);

    const totalCents = Math.round(Number(order.total) * 100);

    // No split at payment time — all money goes to platform.
    // Transfers to vendor/deliverer happen after delivery is confirmed.

    const phone = this.formatPhoneForPagarme(customer.phone);

    // Unique code per attempt to avoid Pagar.me duplicate rejection (max 52 chars)
    const uniqueCode = `${order.id}-${Date.now()}`;

    const orderBody: any = {
      code: uniqueCode,
      items: [
        {
          amount: totalCents,
          description: `Pedido ${order.orderNumber} (PIX)`.substring(0, 256),
          quantity: 1,
          code: uniqueCode,
        },
      ],
      customer: {
        name: customer.name,
        email: customer.email,
        type: 'individual',
        document: customer.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        ...(phone ? { phones: { mobile_phone: phone } } : {}),
      },
      payments: [
        {
          payment_method: 'pix',
          pix: {
            expires_in: 1800, // 30 minutes
            additional_information: [
              { name: 'Pedido', value: order.orderNumber },
            ],
          },
        },
      ],
      metadata: {
        order_id: order.id,
        order_number: order.orderNumber,
      },
      closed: true,
    };

    try {
      const result = await this.pagarmePost('/orders', orderBody);

      // Extract PIX data from charge
      const charge = result.charges?.[0];
      const lastTransaction = charge?.last_transaction;
      const qrCode = lastTransaction?.qr_code || '';
      const qrCodeUrl = lastTransaction?.qr_code_url || '';

      this.logger.log(
        `Pagar.me PIX order created for ${order.orderNumber} | total: ${order.total} | pagarme_order: ${result.id}`,
      );

      return {
        checkoutUrl: qrCodeUrl || '',
        preferenceId: result.id,
        qrCode,
        qrCodeUrl,
      };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me PIX order failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(
        errorData?.message || 'Erro ao criar pagamento PIX no Pagar.me',
      );
    }
  }

  // ─── Pre-Auth Capture & Cancel ─────────────────────────────────────────

  // Captura a pré-autorização SEM split — tudo vai pra plataforma.
  // Transfers to vendor/deliverer happen after delivery is confirmed.
  async capturePreAuth(order: Order): Promise<{ status: string }> {
    if (!order.preAuthChargeId) {
      throw new BadRequestException('Pedido nao possui pre-autorizacao');
    }

    const totalCents = Math.round(Number(order.total) * 100);

    try {
      // L11: Add timestamp to code to ensure uniqueness across retries
      const body: any = { amount: totalCents, code: `${order.id.replace(/-/g, '')}-c${Date.now()}` };

      const result = await this.pagarmePost(`/charges/${order.preAuthChargeId}/capture`, body);
      this.logger.log(`Pre-auth captured for order #${order.orderNumber} | charge: ${order.preAuthChargeId} | no split (platform holds funds)`);

      return { status: result.status || 'paid' };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pre-auth capture failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao capturar pagamento');
    }
  }

  // Captura a pré-autorização COM split — distribui para vendor, deliverer e plataforma.
  async captureWithSplit(order: Order): Promise<{ status: string }> {
    if (!order.preAuthChargeId) {
      throw new BadRequestException('Pedido nao possui pre-autorizacao');
    }

    const store = order.store;
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    const platformRecipientId = this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID');

    if (!vendorRecipientId) {
      throw new BadRequestException('Vendedor sem recipient Pagar.me cadastrado');
    }
    if (!platformRecipientId) {
      throw new BadRequestException('Platform recipient ID nao configurado');
    }

    const totalCents = Math.round(Number(order.total) * 100);
    const commissionCents = Math.round((Number(order.commissionAmount) || 0) * 100);
    const deliveryFeeCents = Math.round((Number(order.deliveryFee) || 0) * 100);
    const deliveryCommissionPercent = await this.platformConfigService.getDeliveryCommissionPercent();

    const splitRules: any[] = [];
    let vendorAmount: number;
    let platformAmount: number;

    const hasExternalDelivery = !store?.hasOwnDelivery && !order.isPickup && deliveryFeeCents > 0;

    if (hasExternalDelivery) {
      const delivery = (order as any).delivery;
      const delivererRecipientId = delivery?.deliverer?.pagarmeRecipientId;
      const deliveryCommissionCents = Math.round(deliveryFeeCents * (deliveryCommissionPercent / 100));
      const delivererAmount = deliveryFeeCents - deliveryCommissionCents;

      vendorAmount = totalCents - commissionCents - deliveryFeeCents;
      platformAmount = commissionCents + deliveryCommissionCents;

      if (delivererRecipientId && delivererAmount > 0) {
        splitRules.push({
          amount: delivererAmount,
          recipient_id: delivererRecipientId,
          type: 'flat',
          options: { charge_processing_fee: false, liable: false, charge_remainder_fee: false },
        });
      } else {
        // No deliverer recipient — platform absorbs deliverer share
        platformAmount += delivererAmount;
      }
    } else {
      // Pickup or own delivery — vendor gets total minus commission
      vendorAmount = totalCents - commissionCents;
      platformAmount = commissionCents;
    }

    // Cap vendor at 0 minimum
    if (vendorAmount < 0) {
      platformAmount += vendorAmount;
      vendorAmount = 0;
    }

    if (vendorAmount > 0) {
      splitRules.push({
        amount: vendorAmount,
        recipient_id: vendorRecipientId,
        type: 'flat',
        options: { charge_processing_fee: false, liable: false, charge_remainder_fee: false },
      });
    } else {
      platformAmount = totalCents - splitRules.reduce((sum, r) => sum + r.amount, 0);
    }

    // Platform gets remainder (absorbs MDR, rounding, and liability)
    const splitSum = splitRules.reduce((sum, r) => sum + r.amount, 0);
    platformAmount = totalCents - splitSum;

    if (platformAmount > 0) {
      splitRules.push({
        amount: platformAmount,
        recipient_id: platformRecipientId,
        type: 'flat',
        options: { charge_processing_fee: true, liable: true, charge_remainder_fee: true },
      });
    }

    // Final validation
    const finalSum = splitRules.reduce((sum, r) => sum + r.amount, 0);
    if (finalSum !== totalCents) {
      this.logger.error(`Split sum mismatch for order #${order.orderNumber}: sum=${finalSum}, total=${totalCents}`);
      throw new BadRequestException('Erro no calculo do split');
    }

    try {
      const body = {
        amount: totalCents,
        code: `${order.id.replace(/-/g, '')}-s${Date.now()}`,
        split: splitRules,
      };

      const result = await this.pagarmePost(`/charges/${order.preAuthChargeId}/capture`, body);
      this.logger.log(`Capture-with-split for order #${order.orderNumber} | total: ${totalCents} | splits: ${splitRules.map(r => `${r.recipient_id}:${r.amount}`).join(', ')}`);

      return { status: result.status || 'paid' };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Capture-with-split failed for order #${order.orderNumber}: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao capturar pagamento com split');
    }
  }

  // Cancela a pré-autorização (libera o limite do cartão)
  async cancelPreAuth(order: Order): Promise<void> {
    if (!order.preAuthChargeId) return;

    try {
      await this.pagarmeDelete(`/charges/${order.preAuthChargeId}`);
      this.logger.log(`Pre-auth cancelled for order #${order.orderNumber} | charge: ${order.preAuthChargeId}`);
    } catch (err: any) {
      // Se falhar, pode já ter expirado ou sido cancelada
      this.logger.warn(`Pre-auth cancel failed (may already be expired): ${err.response?.data?.message || err.message}`);
    }
  }

  // C1 + C3: Reverse settlement from vendor/deliverer back to platform
  // Used on chargeback or refund of already-completed (settled) orders
  async reverseSettlementTransfers(order: Order): Promise<void> {
    if (!order.isSettled) {
      this.logger.log(`No settlement to reverse for order #${order.orderNumber} (not settled)`);
      return;
    }

    // Credit card with capture-with-split: refund on the charge reverses splits automatically
    if (order.paymentMethod === 'CREDIT_CARD' && order.preAuthChargeId && order.capturedAt) {
      this.logger.log(`Order #${order.orderNumber} settled via capture-with-split — refund will reverse splits automatically`);
      return;
    }

    // PIX: manual transfer reversal (existing logic)
    const store = order.store;
    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const reversalErrors: string[] = [];

    const totalCents = Math.round(Number(order.total) * 100);
    const commissionCents = Math.round((Number(order.commissionAmount) || 0) * 100);
    const deliveryFeeCents = Math.round((Number(order.deliveryFee) || 0) * 100);
    const deliveryCommissionPercent = await this.platformConfigService.getDeliveryCommissionPercent();

    // Reverse deliverer transfer
    if (!store?.hasOwnDelivery && !order.isPickup && deliveryFeeCents > 0) {
      const delivery = (order as any).delivery;
      const delivererRecipientId = delivery?.deliverer?.pagarmeRecipientId;
      if (delivererRecipientId) {
        const deliveryCommissionCents = Math.round(deliveryFeeCents * (deliveryCommissionPercent / 100));
        const delivererAmount = deliveryFeeCents - deliveryCommissionCents;
        if (delivererAmount > 0) {
          try {
            await this.pagarmePost('/transfers', {
              amount: delivererAmount,
              recipient_id: this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID'),
              source_recipient_id: delivererRecipientId,
              metadata: {
                order_id: order.id,
                order_number: order.orderNumber,
                type: 'chargeback_reversal_deliverer',
              },
            });
            this.logger.log(`Reversed deliverer transfer for order #${order.orderNumber} | amount: ${delivererAmount} cents`);
          } catch (err: any) {
            this.logger.error(`CRITICAL: Failed to reverse deliverer transfer for order #${order.orderNumber}: ${JSON.stringify(err.response?.data || err.message)}`);
            reversalErrors.push(`deliverer_reversal:${delivererAmount}:FAILED`);
          }
        }
      }
    }

    // Reverse vendor transfer
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    if (vendorRecipientId) {
      const platformDeliveryFee = (!store?.hasOwnDelivery && !order.isPickup) ? deliveryFeeCents : 0;
      const vendorAmount = Math.max(0, totalCents - commissionCents - platformDeliveryFee);
      if (vendorAmount > 0) {
        try {
          await this.pagarmePost('/transfers', {
            amount: vendorAmount,
            recipient_id: this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID'),
            source_recipient_id: vendorRecipientId,
            metadata: {
              order_id: order.id,
              order_number: order.orderNumber,
              type: 'chargeback_reversal_vendor',
            },
          });
          this.logger.log(`Reversed vendor transfer for order #${order.orderNumber} | amount: ${vendorAmount} cents`);
        } catch (err: any) {
          this.logger.error(`CRITICAL: Failed to reverse vendor transfer for order #${order.orderNumber}: ${JSON.stringify(err.response?.data || err.message)}`);
          reversalErrors.push(`vendor_reversal:${vendorAmount}:FAILED`);
        }
      }
    }

    if (reversalErrors.length > 0) {
      await orderRepo.update(order.id, {
        notes: `${order.notes || ''}\n[REVERSAL_ERRORS] ${reversalErrors.join(' | ')}`.trim(),
      });
    }
  }

  // Settle payment after delivery is confirmed.
  // Credit card: capture with split rules (Pagar.me distributes automatically).
  // PIX: manual transfers (balance is instant).
  async settlePayment(order: Order): Promise<void> {
    // C2: Atomic idempotency guard — prevents double settlement
    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const settleResult = await orderRepo.manager.query(
      `UPDATE orders SET "isSettled" = true WHERE id = $1 AND "isSettled" = false RETURNING id`,
      [order.id],
    );
    if (!settleResult || settleResult.length === 0) {
      this.logger.warn(`Settlement skipped for order #${order.orderNumber} — already settled`);
      return;
    }

    // Credit card with pre-auth still pending: capture with split (Pagar.me distributes automatically)
    // If capturedAt is already set (e.g. antifraud auto-capture), skip to manual transfers below
    if (order.paymentMethod === 'CREDIT_CARD' && order.preAuthChargeId && !order.capturedAt) {
      try {
        await this.captureWithSplit(order);
        await orderRepo.update(order.id, { capturedAt: new Date() });
        const totalCents = Math.round(Number(order.total) * 100);
        this.logger.log(`Settlement for order #${order.orderNumber} | capture-with-split | total: ${totalCents} cents`);
      } catch (err: any) {
        this.logger.error(`Settlement failed for order #${order.orderNumber}: ${err.message}`);
        // Revert isSettled so it can be retried
        await orderRepo.update(order.id, { isSettled: false } as any);
        throw err;
      }
      return;
    }

    // PIX and other methods: manual transfers (existing logic)
    const store = order.store;
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    const totalCents = Math.round(Number(order.total) * 100);
    const commissionCents = Math.round((Number(order.commissionAmount) || 0) * 100);
    const deliveryFeeCents = Math.round((Number(order.deliveryFee) || 0) * 100);

    const deliveryCommissionPercent = await this.platformConfigService.getDeliveryCommissionPercent();

    // Track settlement status on the order
    const settlementErrors: string[] = [];

    // 1. Transfer to deliverer (if applicable)
    if (!store?.hasOwnDelivery && !order.isPickup && deliveryFeeCents > 0) {
      const delivery = (order as any).delivery;
      const delivererRecipientId = delivery?.deliverer?.pagarmeRecipientId;

      if (delivererRecipientId) {
        const deliveryCommissionCents = Math.round(deliveryFeeCents * (deliveryCommissionPercent / 100));
        const delivererAmount = deliveryFeeCents - deliveryCommissionCents;

        if (delivererAmount > 0) {
          try {
            const result = await this.pagarmePost('/transfers', {
              amount: delivererAmount,
              recipient_id: delivererRecipientId,
              metadata: {
                order_id: order.id,
                order_number: order.orderNumber,
                type: 'delivery_fee',
              },
            });
            this.logger.log(`Transfer to deliverer for order #${order.orderNumber} | amount: ${delivererAmount} cents | transfer: ${result.id}`);
          } catch (err: any) {
            const errorDetail = JSON.stringify(err.response?.data || err.message);
            this.logger.error(`Transfer to deliverer failed for order #${order.orderNumber}: ${errorDetail}`);
            settlementErrors.push(`deliverer:${delivererAmount}:${errorDetail}`);
            this.notificationsService.sendToVendorUser(
              store.owner?.id,
              'Falha na transferência',
              `Transferência para entregador do pedido #${order.orderNumber} falhou (R$ ${(delivererAmount / 100).toFixed(2)}). Verifique no painel.`,
              { type: 'TRANSFER_FAILED', orderId: order.id },
            ).catch(() => {});
          }
        }
      } else {
        this.logger.warn(`No deliverer recipient for order #${order.orderNumber}, skipping deliverer transfer`);
      }
    }

    // 2. Transfer to vendor
    if (vendorRecipientId) {
      const platformDeliveryFee = (!store?.hasOwnDelivery && !order.isPickup) ? deliveryFeeCents : 0;
      const vendorAmount = totalCents - commissionCents - platformDeliveryFee;

      if (vendorAmount > 0) {
        try {
          const result = await this.pagarmePost('/transfers', {
            amount: vendorAmount,
            recipient_id: vendorRecipientId,
            metadata: {
              order_id: order.id,
              order_number: order.orderNumber,
              type: 'vendor_payment',
            },
          });
          this.logger.log(`Transfer to vendor for order #${order.orderNumber} | amount: ${vendorAmount} cents | transfer: ${result.id}`);
        } catch (err: any) {
          const errorDetail = JSON.stringify(err.response?.data || err.message);
          this.logger.error(`Transfer to vendor failed for order #${order.orderNumber}: ${errorDetail}`);
          settlementErrors.push(`vendor:${vendorAmount}:${errorDetail}`);
          this.notificationsService.sendToVendorUser(
            store.owner?.id,
            'Falha na transferência',
            `A transferência do pedido #${order.orderNumber} (R$ ${(vendorAmount / 100).toFixed(2)}) falhou. Entre em contato com o suporte.`,
            { type: 'TRANSFER_FAILED', orderId: order.id },
          ).catch(() => {});
        }
      } else {
        // H4: Cap vendor amount at 0 (never negative) and notify vendor
        this.logger.warn(`Vendor amount for order #${order.orderNumber} is ${vendorAmount} cents (zero or negative), skipping transfer`);
        const explanation = `Valor do vendedor zerado: comissao (${commissionCents / 100}) + taxa entrega (${platformDeliveryFee / 100}) >= total (${totalCents / 100})`;
        await orderRepo.update(order.id, {
          notes: `${order.notes || ''}\n[VENDOR_ZERO] ${explanation}`.trim(),
        });
        if (store.owner?.id) {
          this.notificationsService.sendToVendorUser(
            store.owner.id,
            'Transferência zerada',
            `Pedido #${order.orderNumber}: ${explanation}`,
            { type: 'VENDOR_ZERO_AMOUNT', orderId: order.id },
          ).catch(() => {});
        }
      }
    } else {
      this.logger.warn(`No vendor recipient for order #${order.orderNumber}, skipping vendor transfer`);
    }

    // Track failed settlements in order notes for superadmin visibility
    if (settlementErrors.length > 0) {
      await orderRepo.update(order.id, {
        notes: `${order.notes || ''}\n[SETTLEMENT_ERRORS] ${settlementErrors.join(' | ')}`.trim(),
      });
    }

    const deliveryCommissionCents = (!store?.hasOwnDelivery && !order.isPickup)
      ? Math.round(deliveryFeeCents * (deliveryCommissionPercent / 100))
      : 0;
    const platformKeeps = commissionCents + deliveryCommissionCents;
    this.logger.log(`Settlement for order #${order.orderNumber} | platform keeps: ${platformKeeps} cents`);
  }

  // ─── Payment Link (hosted checkout) ────────────────────────────────────

  private async createPaymentLink(order: Order, totalCents: number, splitRules: any[]): Promise<string> {
    const body: any = {
      name: `Pedido ${order.orderNumber}`,
      type: 'order',
      amount: totalCents,
      accepted_payment_methods: ['credit_card', 'pix'],
      payment_settings: {
        credit_card: {
          installments: [{ number: 1, total: totalCents }],
          statement_descriptor: STATEMENT_DESCRIPTOR,
        },
        pix: {
          expires_in: 1800,
        },
      },
      items: [
        {
          description: `Pedido ${order.orderNumber}`.substring(0, 256),
          quantity: 1,
          amount: totalCents,
        },
      ],
      ...(splitRules.length > 0 ? { split: splitRules } : {}),
      metadata: {
        order_id: order.id,
        order_number: order.orderNumber,
      },
    };

    try {
      const result = await this.pagarmePost('/paymentlinks', body);
      return result.url || `https://pagar.me/pay/${result.id}`;
    } catch (err: any) {
      this.logger.error(`Payment link creation failed: ${JSON.stringify(err.response?.data || err.message)}`);
      throw new BadRequestException('Erro ao gerar link de pagamento. Tente novamente.');
    }
  }

  // ─── Plan Upgrade ──────────────────────────────────────────────────────

  async createPlanUpgrade(user: VendorUser, plan: VendorPlan, billingPeriod: string = 'monthly'): Promise<Payment> {
    // M5: Use dynamic config from platformConfigService instead of hardcoded PLAN_CONFIGS
    const planConfig = await this.platformConfigService.getPlanConfig(plan);
    if (!planConfig || planConfig.monthlyPrice === 0) {
      throw new BadRequestException('Plano invalido para upgrade');
    }

    // L6: CUSTOM plan requires contact with sales, cannot self-upgrade
    if (planConfig.isContactSales) {
      throw new BadRequestException('Plano personalizado requer contato com a equipe de vendas.');
    }

    // Validate plan hierarchy: cannot downgrade
    const planHierarchy: Record<string, number> = { FREE: 0, PRO: 1, PREMIUM: 2, ENTERPRISE: 3 };
    const currentLevel = planHierarchy[user.vendorPlan || 'FREE'] ?? 0;
    const targetLevel = planHierarchy[plan] ?? 0;
    if (targetLevel <= currentLevel) {
      throw new BadRequestException('Você já possui um plano igual ou superior.');
    }

    if (!user.acceptedSubscriptionTermsAt) {
      throw new BadRequestException('Voce precisa aceitar o contrato de assinatura antes de assinar um plano.');
    }

    const billingMap: Record<string, { price: number; months: number; label: string }> = {
      monthly: { price: planConfig.monthlyPrice, months: 1, label: 'Mensal' },
      quarterly: { price: planConfig.quarterlyPrice, months: 3, label: 'Trimestral' },
      semiannual: { price: planConfig.semiannualPrice, months: 6, label: 'Semestral' },
      annual: { price: planConfig.annualPrice, months: 12, label: 'Anual' },
    };

    const billing = billingMap[billingPeriod] || billingMap.monthly;

    let badgeDiscount = 0;
    const stores = await this.storesRepository.find({
      where: { owner: { id: user.id } },
    });
    for (const store of stores) {
      if (store.badgeClaimCount >= 2) {
        const rewards = await this.platformConfigService.getBadgeRewards(store.verificationLevel);
        if (rewards.subscriptionDiscount > badgeDiscount) {
          badgeDiscount = rewards.subscriptionDiscount;
        }
      }
    }
    if (badgeDiscount > 0) {
      billing.price = Math.round(billing.price * (1 - badgeDiscount / 100) * 100) / 100;
      this.logger.log(`Applied ${badgeDiscount}% badge subscription discount for vendor ${user.id}`);
    }

    const totalCents = Math.round(billing.price * 100);

    // Create payment link for plan upgrade
    const body: any = {
      name: `Plano ${plan} ${billing.label} - bcmTech Delivery`,
      type: 'order',
      amount: totalCents,
      accepted_payment_methods: ['credit_card', 'pix'],
      payment_settings: {
        credit_card: {
          installments: Array.from({ length: Math.min(billing.months, 12) }, (_, i) => ({
            number: i + 1,
            total: totalCents,
          })),
          statement_descriptor: STATEMENT_DESCRIPTOR,
        },
        pix: {
          expires_in: 86400, // 24 hours
        },
      },
      items: [
        {
          description: `Plano ${plan} ${billing.label}`.substring(0, 256),
          quantity: 1,
          amount: totalCents,
        },
      ],
      metadata: {
        type: 'plan_upgrade',
        user_id: user.id,
        plan,
        billing_period: billingPeriod,
        duration_months: billing.months,
      },
    };

    try {
      const result = await this.pagarmePost('/paymentlinks', body);
      const checkoutUrl = result.url || `https://pagar.me/pay/${result.id}`;

      const payment = this.paymentsRepository.create({
        type: 'PLAN_UPGRADE',
        description: `Upgrade para plano ${plan} (${billing.label})`,
        amount: billing.price,
        status: 'pending',
        pagarmeOrderId: result.id,
        checkoutUrl,
        metadata: { plan, durationMonths: billing.months, billingPeriod },
        vendorUser: user,
      });

      const saved = await this.paymentsRepository.save(payment);

      if (user.phone) {
        this.whatsAppService.notifyPlanUpgrade(user.phone, user.name, plan, billing.label).catch(() => {});
      }

      return saved;
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Plan upgrade payment link failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException('Erro ao criar link de pagamento para upgrade de plano');
    }
  }

  // ─── Promotion Checkout ────────────────────────────────────────────────

  async createPromotionCheckout(promotion: Promotion, user: VendorUser): Promise<Payment> {
    const totalCents = Math.round(Number(promotion.adCost) * 100);

    const body: any = {
      name: `Promoção: ${promotion.title}`,
      type: 'order',
      amount: totalCents,
      accepted_payment_methods: ['credit_card', 'pix'],
      payment_settings: {
        credit_card: {
          installments: [{ number: 1, total: totalCents }],
          statement_descriptor: STATEMENT_DESCRIPTOR,
        },
        pix: {
          expires_in: 86400,
        },
      },
      items: [
        {
          description: `Promoção: ${promotion.title}`.substring(0, 256),
          quantity: 1,
          amount: totalCents,
        },
      ],
      metadata: {
        type: 'promotion',
        promotion_id: promotion.id,
        user_id: user.id,
      },
    };

    try {
      const result = await this.pagarmePost('/paymentlinks', body);
      const checkoutUrl = result.url || `https://pagar.me/pay/${result.id}`;

      const payment = this.paymentsRepository.create({
        type: 'PROMOTION',
        description: `Promoção: ${promotion.title}`,
        amount: Number(promotion.adCost),
        status: 'pending',
        pagarmeOrderId: result.id,
        checkoutUrl,
        metadata: { promotionId: promotion.id },
        vendorUser: user,
      });

      return this.paymentsRepository.save(payment);
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Promotion payment link failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException('Erro ao criar link de pagamento para promoção');
    }
  }

  // ─── Recipient Registration (replaces MP OAuth) ────────────────────────

  private async findExistingRecipientByCpf(cpf: string, excludeUserId: string): Promise<string | null> {
    const cleanCpf = cpf.replace(/\D/g, '');

    // Checar se algum entregador com esse CPF já tem recipient
    const deliverer = await this.appUsersService.findByCpfWithRecipient(cleanCpf);
    if (deliverer && deliverer.id !== excludeUserId && deliverer.pagarmeRecipientId) {
      return deliverer.pagarmeRecipientId;
    }

    // Checar se algum vendedor com esse CPF já tem recipient
    const vendor = await this.vendorUsersService.findByCpfWithRecipient(cleanCpf);
    if (vendor && vendor.id !== excludeUserId && vendor.pagarmeRecipientId) {
      return vendor.pagarmeRecipientId;
    }

    return null;
  }

  async registerVendorRecipient(userId: string, recipientData: any): Promise<{ recipientId: string }> {
    const vendor = await this.vendorUsersService.findById(userId);
    if (!vendor) throw new NotFoundException('Vendedor não encontrado');

    // Se já tem recipient, atualiza
    if (vendor.pagarmeRecipientId) {
      await this.updateRecipient(vendor.pagarmeRecipientId, recipientData);
      return { recipientId: vendor.pagarmeRecipientId };
    }

    // Reutilizar recipient se o mesmo CPF já existe em outro papel (ex: entregador)
    const existingRecipientId = await this.findExistingRecipientByCpf(recipientData.document, userId);
    if (existingRecipientId) {
      this.logger.log(`Reusing existing recipient ${existingRecipientId} for vendor ${userId} (same CPF)`);
      await this.updateRecipient(existingRecipientId, recipientData);
      await this.vendorUsersService.updatePagarmeRecipient(userId, existingRecipientId);
      return { recipientId: existingRecipientId };
    }

    try {
      const result = await this.createRecipient({
        ...recipientData,
        code: `vendor_${userId}`,
      });
      await this.vendorUsersService.updatePagarmeRecipient(userId, result.id);
      return { recipientId: result.id };
    } catch (err: any) {
      const errorMsg = JSON.stringify(err.response?.data || err.message || '');
      if (errorMsg.includes('unique') || errorMsg.includes('External ID') || errorMsg.includes('external_id')) {
        this.logger.warn(`Vendor recipient vendor_${userId} already exists on Pagar.me, recovering...`);
        try {
          const existing = await this.pagarmeGet(`/recipients?code=vendor_${userId}`);
          const recipientId = existing?.data?.[0]?.id;
          if (recipientId) {
            await this.vendorUsersService.updatePagarmeRecipient(userId, recipientId);
            await this.updateRecipient(recipientId, recipientData);
            return { recipientId };
          }
        } catch { /* fall through */ }
      }
      throw err;
    }
  }

  async registerDelivererRecipient(userId: string, recipientData: any): Promise<{ recipientId: string }> {
    const deliverer = await this.appUsersService.findById(userId);
    if (!deliverer) throw new NotFoundException('Entregador não encontrado');

    // Se já tem recipient, atualiza
    if (deliverer.pagarmeRecipientId) {
      await this.updateRecipient(deliverer.pagarmeRecipientId, recipientData);
      return { recipientId: deliverer.pagarmeRecipientId };
    }

    // Reutilizar recipient se o mesmo CPF já existe em outro papel (ex: vendedor)
    const existingRecipientId = await this.findExistingRecipientByCpf(recipientData.document, userId);
    if (existingRecipientId) {
      this.logger.log(`Reusing existing recipient ${existingRecipientId} for deliverer ${userId} (same CPF)`);
      await this.updateRecipient(existingRecipientId, recipientData);
      await this.appUsersService.updatePagarmeRecipient(userId, existingRecipientId);
      return { recipientId: existingRecipientId };
    }

    try {
      const result = await this.createRecipient({
        ...recipientData,
        code: `deliverer_${userId}`,
      });
      await this.appUsersService.updatePagarmeRecipient(userId, result.id);
      return { recipientId: result.id };
    } catch (err: any) {
      const errorMsg = JSON.stringify(err.response?.data || err.message || '');
      if (errorMsg.includes('unique') || errorMsg.includes('External ID') || errorMsg.includes('external_id')) {
        this.logger.warn(`Deliverer recipient deliverer_${userId} already exists on Pagar.me, recovering...`);
        try {
          const existing = await this.pagarmeGet(`/recipients?code=deliverer_${userId}`);
          const recipientId = existing?.data?.[0]?.id;
          if (recipientId) {
            await this.appUsersService.updatePagarmeRecipient(userId, recipientId);
            await this.updateRecipient(recipientId, recipientData);
            return { recipientId };
          }
        } catch { /* fall through */ }
      }
      throw err;
    }
  }

  async disconnectVendor(userId: string): Promise<void> {
    const vendor = await this.vendorUsersService.findById(userId);
    if (vendor?.pagarmeRecipientId) {
      try {
        const balance = await this.getRecipientBalance(vendor.pagarmeRecipientId);
        const pendingTotal = balance.waitingFundsAmount + balance.availableAmount;
        if (pendingTotal > 0) {
          throw new BadRequestException(
            `Você tem R$ ${pendingTotal.toFixed(2)} em saldo (R$ ${balance.availableAmount.toFixed(2)} disponível + R$ ${balance.waitingFundsAmount.toFixed(2)} a receber). Saque ou aguarde antes de desconectar.`,
          );
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        this.logger.error(`Balance check failed during disconnect for vendor ${userId}: ${err}`);
        throw new BadRequestException('Não foi possível verificar seu saldo. Tente novamente mais tarde.');
      }
    }
    await this.vendorUsersService.disconnectPayment(userId);
  }

  async disconnectApp(userId: string): Promise<void> {
    const user = await this.appUsersService.findById(userId);
    if (user?.pagarmeRecipientId) {
      try {
        const balance = await this.getRecipientBalance(user.pagarmeRecipientId);
        const pendingTotal = balance.waitingFundsAmount + balance.availableAmount;
        if (pendingTotal > 0) {
          throw new BadRequestException(
            `Você tem R$ ${pendingTotal.toFixed(2)} em saldo. Saque ou aguarde antes de desconectar.`,
          );
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        this.logger.error(`Balance check failed during disconnect for user ${userId}: ${err}`);
        throw new BadRequestException('Não foi possível verificar seu saldo. Tente novamente mais tarde.');
      }
    }
    await this.appUsersService.disconnectPayment(userId);
  }

  // ─── Webhook ───────────────────────────────────────────────────────────

  // H1: In-memory set kept as fast-path cache; DB is source of truth
  private processedWebhooks = new Set<string>();
  private webhookCleanupInterval = setInterval(() => {
    if (this.processedWebhooks.size > 1000) this.processedWebhooks.clear();
  }, 10 * 60 * 1000);

  async handleWebhook(body: any): Promise<void> {
    const eventType = body.type;
    const data = body.data;

    if (!data) return;

    // H1: Database-backed deduplication for webhook events
    const eventKey = `${eventType}:${data.id}`;
    // Fast-path: check in-memory cache first
    if (this.processedWebhooks.has(eventKey)) {
      this.logger.log(`Webhook duplicate skipped (cache): ${eventKey}`);
      return;
    }
    // DB-level dedup: try to insert; unique constraint prevents duplicates
    try {
      await this.webhookEventsRepository.insert({ eventKey });
    } catch (err: any) {
      // Unique constraint violation means already processed
      if (err?.code === '23505' || err?.message?.includes('duplicate')) {
        this.logger.log(`Webhook duplicate skipped (DB): ${eventKey}`);
        this.processedWebhooks.add(eventKey);
        return;
      }
      // Other DB errors: log but continue processing (fail-open)
      this.logger.warn(`Webhook dedup DB error: ${err.message}`);
    }
    this.processedWebhooks.add(eventKey);

    this.logger.log(`Webhook received: ${eventType} | id: ${data.id}`);

    // Handle order events
    if (eventType === 'order.paid') {
      await this.handleOrderPaid(data);
    } else if (eventType === 'order.payment_failed') {
      await this.handleOrderPaymentFailed(data);
    } else if (eventType === 'order.canceled') {
      await this.handleOrderCanceled(data);
    } else if (eventType === 'charge.paid') {
      await this.handleChargePaid(data);
    } else if (eventType === 'charge.refunded') {
      await this.handleChargeRefunded(data);
    } else if (eventType === 'charge.chargedback') {
      await this.handleChargeChargedback(data);
    } else if (eventType === 'charge.payment_failed') {
      await this.handleOrderPaymentFailed(data);
    } else if (eventType.startsWith('anticipation.')) {
      this.logger.log(`Anticipation event: ${eventType} | id: ${data.id} | status: ${data.status}`);
    }
  }

  private async handleOrderPaid(data: any): Promise<void> {
    const pagarmeOrderId = data.id;
    const metadata = data.metadata || {};
    const code = data.code || '';

    // Check if it's a plan upgrade
    if (metadata.type === 'plan_upgrade') {
      const payment = await this.paymentsRepository.findOne({
        where: { pagarmeOrderId },
        relations: ['vendorUser'],
      });
      if (payment) {
        payment.status = 'approved';
        await this.paymentsRepository.save(payment);
      }
      if (metadata.user_id && metadata.plan) {
        await this.vendorUsersService.updateVendorPlan(
          metadata.user_id,
          metadata.plan as VendorPlan,
          parseInt(metadata.duration_months) || 1,
        );
      }
      return;
    }

    // Check if it's a promotion
    if (metadata.type === 'promotion') {
      const payment = await this.paymentsRepository.findOne({
        where: { pagarmeOrderId },
      });
      if (payment) {
        payment.status = 'approved';
        await this.paymentsRepository.save(payment);
      }
      if (metadata.promotion_id) {
        const promoRepo = this.paymentsRepository.manager.getRepository(Promotion);
        const productRepo = this.paymentsRepository.manager.getRepository('Product');
        const promotion = await promoRepo.findOne({
          where: { id: metadata.promotion_id },
          relations: ['product'],
        });
        if (promotion && !promotion.isPaid) {
          promotion.isPaid = true;
          await promoRepo.save(promotion);
          if (promotion.product && promotion.promotionalPrice) {
            const now = new Date();
            if (now >= new Date(promotion.startDate) && now <= new Date(promotion.endDate)) {
              await productRepo.update(promotion.product.id, {
                promotionalPrice: promotion.promotionalPrice,
              });
            }
          }
        }
      }
      return;
    }

    // Handle order payment
    const orderId = metadata.order_id || (code ? code.replace(/^([a-f0-9-]{36}).*$/, '$1') : null);
    if (orderId) {
      const orderRepo = this.paymentsRepository.manager.getRepository(Order);
      const order = await orderRepo.findOne({
        where: { id: orderId },
        relations: ['customer', 'store'],
      });

      if (order && (order.status === OrderStatus.AWAITING_PAYMENT || order.status === OrderStatus.PAYMENT_REVIEW)) {
        // Update mpPreferenceId with real Pagar.me order ID (replaces placeholder from payment link flow)
        if (order.mpPreferenceId?.startsWith('link-') && pagarmeOrderId) {
          order.mpPreferenceId = pagarmeOrderId;
        }

        order.status = OrderStatus.PENDING;
        order.couponCredited = true; // Mark so handleChargePaid won't double-increment
        await orderRepo.save(order);
        this.logger.log(`Pagamento aprovado para pedido #${order.orderNumber}`);

        // Re-fetch with full relations so subscription filters can access store.id
        const freshOrder = await orderRepo.findOne({
          where: { id: order.id },
          relations: ['customer', 'store', 'items', 'items.product'],
        });

        // Publish real-time update so app/vendor panel refresh
        if (freshOrder) {
          this.pubSub.publish('orderUpdated', { orderUpdated: freshOrder });
          this.pubSub.publish('orderCreated', { orderCreated: freshOrder });
        }

        // Increment coupon usage now that payment is confirmed
        if (order.couponCode) {
          try {
            const couponRepo = this.paymentsRepository.manager.getRepository('Coupon');
            await couponRepo.increment({ code: order.couponCode }, 'usesCount', 1);
          } catch (err: any) {
            this.logger.warn(`Failed to increment coupon usage for ${order.couponCode}: ${err.message}`);
          }
        }

        // Notify customer
        if (order.customer?.id) {
          this.notificationsService.sendToAppUser(
            order.customer.id,
            'Pagamento confirmado!',
            `Seu pagamento do pedido #${order.orderNumber} foi aprovado. Aguarde a confirmação da loja.`,
            { type: 'PAYMENT_CONFIRMED', orderId: order.id },
          ).catch(() => {});
        }
        if (order.customer?.phone) {
          this.whatsAppService.sendText(
            order.customer.phone,
            `✅ *Pagamento confirmado!*\n\nSeu pagamento do pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) foi aprovado.\n\nAguarde a confirmação da loja!`,
          ).catch(() => {});
        }
      }
    }
  }

  private async handleOrderPaymentFailed(data: any): Promise<void> {
    const metadata = data.metadata || data.order?.metadata || {};
    const orderId = metadata.order_id;
    if (!orderId) return;

    this.logger.warn(`Payment failed for order ${orderId}`);

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'items', 'items.product'],
    });

    if (!order || order.status === OrderStatus.CANCELLED) return;

    // Don't cancel orders in PAYMENT_REVIEW — antifraud reproved but awaiting manual reprocessing
    if (order.status === OrderStatus.PAYMENT_REVIEW) {
      this.logger.log(`Pedido #${order.orderNumber} em PAYMENT_REVIEW — ignorando payment_failed webhook`);
      return;
    }

    order.status = OrderStatus.CANCELLED;
    await orderRepo.save(order);
    this.logger.log(`Pedido #${order.orderNumber} cancelado por falha no pagamento`);

    // Restaurar estoque
    if (order.items) {
      const productRepo = this.paymentsRepository.manager.getRepository('Product');
      for (const item of order.items) {
        if (item.product?.id) {
          await productRepo.increment({ id: item.product.id }, 'stock', item.quantity);
        }
      }
    }

    // Notificar cliente
    if (order.customer?.id) {
      this.notificationsService.sendToAppUser(
        order.customer.id,
        'Pagamento recusado',
        `O pagamento do pedido #${order.orderNumber} foi recusado. Tente novamente com outro método de pagamento.`,
        { type: 'PAYMENT_FAILED', orderId: order.id },
      ).catch(() => {});
    }

    // Notificar vendor
    if (order.store?.owner?.id) {
      this.notificationsService.sendToVendorUser(
        order.store.owner.id,
        'Pedido cancelado',
        `Pedido #${order.orderNumber} cancelado - pagamento recusado.`,
        { type: 'ORDER_CANCELLED', orderId: order.id },
      ).catch(() => {});
    }
  }

  private async handleOrderCanceled(data: any): Promise<void> {
    const metadata = data.metadata || data.order?.metadata || {};
    const orderId = metadata.order_id;
    if (!orderId) return;

    this.logger.warn(`Order canceled on Pagar.me: ${orderId}`);

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'items', 'items.product'],
    });

    if (!order || order.status === OrderStatus.CANCELLED) return;

    order.status = OrderStatus.CANCELLED;
    await orderRepo.save(order);
    this.logger.log(`Pedido #${order.orderNumber} cancelado via Pagar.me webhook`);

    // Restaurar estoque
    if (order.items) {
      const productRepo = this.paymentsRepository.manager.getRepository('Product');
      for (const item of order.items) {
        if (item.product?.id) {
          await productRepo.increment({ id: item.product.id }, 'stock', item.quantity);
        }
      }
    }

    if (order.customer?.id) {
      this.notificationsService.sendToAppUser(
        order.customer.id,
        'Pedido cancelado',
        `Seu pedido #${order.orderNumber} foi cancelado.`,
        { type: 'ORDER_CANCELLED', orderId: order.id },
      ).catch(() => {});
    }
  }

  private async handleChargePaid(data: any): Promise<void> {
    // Fallback: if order.paid webhook doesn't fire, charge.paid confirms the payment
    const metadata = data.metadata || data.order?.metadata || {};
    const code = data.code || data.order?.code || '';
    const orderId = metadata.order_id || (code ? code.replace(/^([a-f0-9-]{36}).*$/, '$1') : null);

    this.logger.log(`Charge paid: ${data.id} | orderId: ${orderId}`);

    if (!orderId) return;

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store'],
    });

    // Update mpPreferenceId with real Pagar.me order ID if still placeholder
    if (order && order.mpPreferenceId?.startsWith('link-')) {
      const realOrderId = data.order?.id || data.id;
      if (realOrderId) {
        order.mpPreferenceId = realOrderId;
        await orderRepo.save(order);
      }
    }

    // Act if order is AWAITING_PAYMENT or PAYMENT_REVIEW (antifraud reprocessed)
    const wasPaymentReview = order?.status === OrderStatus.PAYMENT_REVIEW;
    if (order && (order.status === OrderStatus.AWAITING_PAYMENT || order.status === OrderStatus.PAYMENT_REVIEW)) {
      order.status = OrderStatus.PENDING;
      order.couponCredited = true;
      // Antifraud reprocessing auto-captures the charge (no longer pre-auth)
      if (wasPaymentReview && order.preAuthChargeId && !order.capturedAt) {
        order.capturedAt = new Date();
        this.logger.log(`Charge.paid (antifraud reprocessed): marking capturedAt for order #${order.orderNumber} — charge was auto-captured by Pagar.me`);
      }
      await orderRepo.save(order);
      this.logger.log(`Charge.paid ${wasPaymentReview ? '(antifraud reprocessed)' : 'fallback'}: pedido #${order.orderNumber} confirmado via charge webhook`);

      // Re-fetch with full relations so subscription filters can access store.id
      const freshOrder = await orderRepo.findOne({
        where: { id: order.id },
        relations: ['customer', 'store', 'items', 'items.product'],
      });

      // Publish real-time update so app/vendor panel refresh
      if (freshOrder) {
        this.pubSub.publish('orderUpdated', { orderUpdated: freshOrder });
        this.pubSub.publish('orderCreated', { orderCreated: freshOrder });
      }

      if (order.customer?.id) {
        this.notificationsService.sendToAppUser(
          order.customer.id,
          'Pagamento confirmado!',
          `Seu pagamento do pedido #${order.orderNumber} foi aprovado. Aguarde a confirmação da loja.`,
          { type: 'PAYMENT_CONFIRMED', orderId: order.id },
        ).catch(() => {});
      }
      if (order.customer?.phone) {
        this.whatsAppService.sendText(
          order.customer.phone,
          `✅ *Pagamento confirmado!*\n\nSeu pagamento do pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) foi aprovado.\n\nAguarde a confirmação da loja!`,
        ).catch(() => {});
      }

      // Only increment coupon if handleOrderPaid didn't already do it
      if (order.couponCode && !order.couponCredited) {
        try {
          const couponRepo = this.paymentsRepository.manager.getRepository('Coupon');
          await couponRepo.increment({ code: order.couponCode }, 'usesCount', 1);
        } catch (err: any) {
          this.logger.warn(`Failed to increment coupon usage (charge.paid) for ${order.couponCode}: ${err.message}`);
        }
      }
    }
  }

  private async handleChargeRefunded(data: any): Promise<void> {
    const metadata = data.metadata || data.order?.metadata || {};
    const orderId = metadata.order_id || (data.code ? data.code.replace(/^([a-f0-9-]{36}).*$/, '$1') : null);

    this.logger.log(`Charge refunded: ${data.id} | orderId: ${orderId}`);

    if (!orderId) return;

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'items', 'items.product'],
    });

    if (order && order.status !== OrderStatus.CANCELLED) {
      order.status = OrderStatus.CANCELLED;
      await orderRepo.save(order);
      this.logger.log(`Pedido #${order.orderNumber} cancelado por estorno`);

      // Restaurar estoque
      if (order.items) {
        const productRepo = this.paymentsRepository.manager.getRepository('Product');
        for (const item of order.items) {
          if (item.product?.id) {
            await productRepo.increment({ id: item.product.id }, 'stock', item.quantity);
          }
        }
      }

      if (order.customer?.id) {
        this.notificationsService.sendToAppUser(
          order.customer.id,
          'Reembolso processado',
          `O reembolso do pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) foi processado. O valor será devolvido ao seu meio de pagamento.`,
          { type: 'REFUND_PROCESSED', orderId: order.id },
        ).catch(() => {});
      }
      if (order.customer?.phone) {
        this.whatsAppService.sendText(
          order.customer.phone,
          `💰 *Reembolso processado!*\n\nO valor de R$ ${Number(order.total).toFixed(2)} do pedido #${order.orderNumber} será devolvido ao seu meio de pagamento.`,
        ).catch(() => {});
      }
    }
  }

  private async handleChargeChargedback(data: any): Promise<void> {
    const metadata = data.metadata || data.order?.metadata || {};
    const orderId = metadata.order_id || (data.code ? data.code.replace(/^([a-f0-9-]{36}).*$/, '$1') : null);

    this.logger.warn(`Chargeback received: ${data.id} | orderId: ${orderId}`);

    if (!orderId) return;

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'items', 'items.product', 'delivery', 'delivery.deliverer'],
    });

    if (order) {
      const wasCompleted = order.status === OrderStatus.COMPLETED;
      order.status = OrderStatus.CANCELLED;
      await orderRepo.save(order);
      this.logger.warn(`Pedido #${order.orderNumber} cancelado por chargeback | wasCompleted: ${wasCompleted}`);

      // C1: If order was COMPLETED, reverse settlement transfers
      if (wasCompleted && order.isSettled) {
        this.logger.error(`CRITICAL: Chargeback on COMPLETED order #${order.orderNumber} — reversing transfers`);
        try {
          await this.reverseSettlementTransfers(order);
        } catch (err: any) {
          this.logger.error(`CRITICAL: Transfer reversal failed for chargeback on order #${order.orderNumber}: ${err.message}`);
        }
      }

      // Only restore stock if order was NOT already completed/delivered (products not physically delivered)
      if (!wasCompleted && order.items) {
        const productRepo = this.paymentsRepository.manager.getRepository('Product');
        for (const item of order.items) {
          if (item.product?.id) {
            await productRepo.increment({ id: item.product.id }, 'stock', item.quantity);
          }
        }
      }

      // Notify vendor about chargeback
      if (order.store?.owner?.id) {
        const transferWarning = wasCompleted
          ? ' Os produtos ja foram entregues e as transferencias estao sendo revertidas.'
          : '';
        this.notificationsService.sendToVendorUser(
          order.store.owner.id,
          'Chargeback recebido',
          `O pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) recebeu uma contestação (chargeback).${transferWarning}`,
          { type: 'CHARGEBACK', orderId: order.id },
        ).catch(() => {});
      }
    }
  }

  // ─── Refund ───────────────────────────────────────────────────────────

  async refundOrder(orderId: string): Promise<{ success: boolean; message: string }> {
    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'delivery', 'delivery.deliverer'],
    });

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (!order.mpPreferenceId && !order.preAuthChargeId) throw new BadRequestException('Este pedido não possui pagamento online para estornar');
    if ([OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.EXPIRED].includes(order.status as OrderStatus)) {
      throw new BadRequestException('Este pedido já foi cancelado/rejeitado');
    }

    // C3: If order was COMPLETED and settled, reverse transfers before refunding
    if (order.status === OrderStatus.COMPLETED && order.isSettled) {
      this.logger.warn(`Refund requested for completed+settled order #${order.orderNumber} — reversing transfers first`);
      try {
        await this.reverseSettlementTransfers(order);
      } catch (err: any) {
        this.logger.error(`Transfer reversal failed before refund for order #${order.orderNumber}: ${err.message}`);
      }
    }

    try {
      let chargeId: string | null = null;
      let chargeAmount: number = Math.round(Number(order.total) * 100);

      // 1. Try preAuthChargeId (direct card charge / pre-auth flow)
      if (order.preAuthChargeId) {
        chargeId = order.preAuthChargeId;
      }
      // 2. Try mpPreferenceId as Pagar.me order ID (PIX or payment link with real ID)
      else if (order.mpPreferenceId && !order.mpPreferenceId.startsWith('link-')) {
        const pagarmeOrder = await this.pagarmeGet(`/orders/${order.mpPreferenceId}`);
        const charge = pagarmeOrder.charges?.[0];
        if (!charge) throw new BadRequestException('Cobrança não encontrada no Pagar.me');
        chargeId = charge.id;
        chargeAmount = charge.amount;
      }
      // 3. Payment link placeholder — cannot refund without real charge ID
      else {
        throw new BadRequestException('Não foi possível localizar a cobrança no Pagar.me para estorno. O webhook pode não ter atualizado o ID do pedido.');
      }

      // Verify charge status before refunding
      const chargeData = await this.pagarmeGet(`/charges/${chargeId}`);
      if (chargeData.status !== 'paid' && chargeData.status !== 'captured') {
        throw new BadRequestException(`Cobrança com status "${chargeData.status}" não pode ser estornada`);
      }

      // Request refund
      await this.pagarmePost(`/charges/${chargeId}/refund`, {
        amount: chargeAmount,
      });

      order.status = OrderStatus.CANCELLED;
      await orderRepo.save(order);

      this.logger.log(`Refund requested for order #${order.orderNumber} | charge: ${chargeId}`);

      // Notify customer
      if (order.customer?.id) {
        this.notificationsService.sendToAppUser(
          order.customer.id,
          'Pedido estornado',
          `O pedido #${order.orderNumber} foi cancelado e o reembolso de R$ ${Number(order.total).toFixed(2)} será processado.`,
          { type: 'REFUND_REQUESTED', orderId: order.id },
        ).catch(() => {});
      }
      if (order.customer?.phone) {
        this.whatsAppService.sendText(
          order.customer.phone,
          `💰 *Pedido cancelado e reembolso solicitado!*\n\nO valor de R$ ${Number(order.total).toFixed(2)} do pedido #${order.orderNumber} será devolvido ao seu meio de pagamento em até 7 dias úteis.`,
        ).catch(() => {});
      }

      return { success: true, message: `Estorno solicitado para o pedido #${order.orderNumber}` };
    } catch (err: any) {
      if (err instanceof BadRequestException || err instanceof NotFoundException) throw err;
      const errorData = err.response?.data;
      this.logger.error(`Refund failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao solicitar estorno');
    }
  }

  // ─── Recipient Balance & Anticipation ─────────────────────────────────

  async getRecipientBalance(recipientId: string): Promise<{ availableAmount: number; waitingFundsAmount: number; transferredAmount: number; autoAnticipationEnabled: boolean }> {
    try {
      const [balance, recipient] = await Promise.all([
        this.pagarmeGet(`/recipients/${recipientId}/balance`),
        this.pagarmeGet(`/recipients/${recipientId}`).catch(() => null),
      ]);
      return {
        availableAmount: (balance.available_amount || 0) / 100,
        waitingFundsAmount: (balance.waiting_funds?.amount || 0) / 100,
        transferredAmount: (balance.transferred_amount || 0) / 100,
        autoAnticipationEnabled: recipient?.automatic_anticipation_settings?.enabled ?? false,
      };
    } catch (err: any) {
      this.logger.warn(`Failed to get recipient balance: ${err.response?.data?.message || err.message}`);
      throw new BadRequestException('Não foi possível consultar o saldo. Tente novamente mais tarde.');
    }
  }

  async simulateAnticipation(recipientId: string): Promise<{ originalAmount: number; anticipatedAmount: number; fee: number; feePercentage: number }> {
    try {
      // Get waiting funds first
      const balance = await this.pagarmeGet(`/recipients/${recipientId}/balance`);
      const waitingCents = balance.waiting_funds?.amount || 0;

      if (waitingCents <= 0) {
        return { originalAmount: 0, anticipatedAmount: 0, fee: 0, feePercentage: 0 };
      }

      // Simulate anticipation
      const result = await this.pagarmePost(`/recipients/${recipientId}/anticipations`, {
        payment_date: new Date().toISOString().split('T')[0],
        timeframe: 'start',
        requested_amount: waitingCents,
        type: 'full',
        simulate: true,
      });

      const originalAmount = waitingCents / 100;
      const anticipatedAmount = (result.amount || 0) / 100;
      const fee = originalAmount - anticipatedAmount;
      const feePercentage = originalAmount > 0 ? (fee / originalAmount) * 100 : 0;

      return { originalAmount, anticipatedAmount, fee, feePercentage: Math.round(feePercentage * 100) / 100 };
    } catch (err: any) {
      this.logger.warn(`Failed to simulate anticipation: ${err.response?.data?.message || err.message}`);
      // Fallback: estimate ~3.5% fee
      try {
        const balance = await this.pagarmeGet(`/recipients/${recipientId}/balance`);
        const waitingCents = balance.waiting_funds?.amount || 0;
        const originalAmount = waitingCents / 100;
        const estimatedFee = originalAmount * 0.035;
        return {
          originalAmount,
          anticipatedAmount: originalAmount - estimatedFee,
          fee: Math.round(estimatedFee * 100) / 100,
          feePercentage: 3.5,
        };
      } catch {
        return { originalAmount: 0, anticipatedAmount: 0, fee: 0, feePercentage: 0 };
      }
    }
  }

  async requestAnticipation(recipientId: string): Promise<{ id: string; status: string; requestedAmount: number; approvedAmount: number; fee: number; createdAt: string }> {
    const balance = await this.pagarmeGet(`/recipients/${recipientId}/balance`);
    const waitingCents = balance.waiting_funds?.amount || 0;

    if (waitingCents <= 0) {
      throw new BadRequestException('Não há valores pendentes para antecipar');
    }

    try {
      // Use next business day if today is weekend
      const today = new Date();
      const day = today.getDay();
      if (day === 0) today.setDate(today.getDate() + 1); // Sunday → Monday
      if (day === 6) today.setDate(today.getDate() + 2); // Saturday → Monday
      const paymentDate = today.toISOString().split('T')[0];

      const result = await this.pagarmePost(`/recipients/${recipientId}/anticipations`, {
        payment_date: paymentDate,
        timeframe: 'start',
        requested_amount: waitingCents,
        type: 'full',
      });

      return {
        id: result.id,
        status: result.status || 'pending',
        requestedAmount: waitingCents / 100,
        approvedAmount: (result.amount || 0) / 100,
        fee: (waitingCents - (result.amount || 0)) / 100,
        createdAt: result.created_at || new Date().toISOString(),
      };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Anticipation request failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao solicitar antecipação');
    }
  }

  async updateRecipientAnticipationSettings(recipientId: string, enabled: boolean): Promise<boolean> {
    try {
      await this.pagarmePatch(`/recipients/${recipientId}/automatic-anticipation-settings`, {
        enabled,
        type: 'full',
        volume_percentage: 100,
      });
      return true;
    } catch (err: any) {
      this.logger.error(`Failed to update anticipation settings: ${JSON.stringify(err.response?.data || err.message)}`);
      throw new BadRequestException('Erro ao atualizar configurações de antecipação');
    }
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  async findByVendor(userId: string): Promise<Payment[]> {
    return this.paymentsRepository.find({
      where: { vendorUser: { id: userId } },
      order: { createdAt: 'DESC' },
    });
  }

  async findByAppUser(userId: string): Promise<Payment[]> {
    return this.paymentsRepository.find({
      where: { appUser: { id: userId } },
      order: { createdAt: 'DESC' },
    });
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<Payment[]> {
    return this.paymentsRepository.find({
      relations: ['appUser', 'vendorUser'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  async platformRevenue(): Promise<number> {
    // Revenue from plan upgrades and promotions
    const paymentResult = await this.paymentsRepository
      .createQueryBuilder('payment')
      .select('COALESCE(SUM(payment.amount), 0)', 'total')
      .where('payment.status = :status', { status: 'approved' })
      .andWhere('payment.type IN (:...types)', { types: ['PLAN_UPGRADE', 'PROMOTION'] })
      .getRawOne();
    const paymentRevenue = parseFloat(paymentResult.total);

    // Revenue from order commissions (completed orders)
    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const commissionResult = await orderRepo
      .createQueryBuilder('order')
      .select('COALESCE(SUM(order.commissionAmount), 0)', 'total')
      .where('order.status = :status', { status: OrderStatus.COMPLETED })
      .getRawOne();
    const commissionRevenue = parseFloat(commissionResult.total);

    return paymentRevenue + commissionRevenue;
  }
}
