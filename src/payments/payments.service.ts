import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Payment } from './entities/payment.entity';
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

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly pagarmeBaseUrl = 'https://api.pagar.me/core/v5';
  private readonly pagarmeAuthHeader: string;

  constructor(
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    private configService: ConfigService,
    private httpService: HttpService,
    @Inject(forwardRef(() => AppUsersService))
    private appUsersService: AppUsersService,
    @Inject(forwardRef(() => VendorUsersService))
    private vendorUsersService: VendorUsersService,
    private platformConfigService: PlatformConfigService,
    private whatsAppService: WhatsAppService,
    private notificationsService: NotificationsService,
  ) {
    const secretKey = this.configService.get('PAGARME_SECRET_KEY') || '';
    this.pagarmeAuthHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');
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
      registerInfo.monthly_income = data.monthlyIncome;
      registerInfo.professional_occupation = data.professionalOccupation;
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
          monthly_income: p.monthlyIncome,
          professional_occupation: p.professionalOccupation,
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
      throw new BadRequestException(
        errorData?.message || 'Erro ao cadastrar recebedor no Pagar.me',
      );
    }
  }

  async getRecipient(recipientId: string): Promise<any> {
    return this.pagarmeGet(`/recipients/${recipientId}`);
  }

  // ─── Customers ────────────────────────────────────────────────────────

  private async getOrCreatePagarmeCustomer(user: { name: string; email: string; cpf?: string; phone?: string }): Promise<string | undefined> {
    try {
      const phoneDigits = user.phone?.replace(/\D/g, '') || '';
      const ddd = phoneDigits.length >= 11 ? phoneDigits.substring(0, 2) : '53';
      const phoneNumber = phoneDigits.length >= 11 ? phoneDigits.substring(2) : phoneDigits;

      const customerBody: any = {
        name: user.name,
        email: user.email,
        type: 'individual',
        document: user.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        phones: {
          mobile_phone: {
            country_code: '55',
            area_code: ddd,
            number: phoneNumber || '999999999',
          },
        },
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

  async saveCard(userId: string, cardToken: string): Promise<any> {
    const user = await this.appUsersService.findById(userId);
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    const customerId = await this.ensureCustomer(user);

    try {
      const result = await this.pagarmePost(`/customers/${customerId}/cards`, { token: cardToken });
      return {
        id: result.id,
        lastFourDigits: result.last_four_digits,
        brand: result.brand,
        holderName: result.holder_name,
        expMonth: result.exp_month,
        expYear: result.exp_year,
      };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Failed to save card: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao salvar cartao');
    }
  }

  async listCards(userId: string): Promise<any[]> {
    const user = await this.appUsersService.findById(userId);
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    if (!user.pagarmeCustomerId) return [];

    try {
      const result = await this.pagarmeGet(`/customers/${user.pagarmeCustomerId}/cards`);
      const cards = result.data || result;
      return (Array.isArray(cards) ? cards : []).map((c: any) => ({
        id: c.id,
        lastFourDigits: c.last_four_digits,
        brand: c.brand,
        holderName: c.holder_name,
        expMonth: c.exp_month,
        expYear: c.exp_year,
      }));
    } catch (err: any) {
      this.logger.warn(`Failed to list cards: ${err.response?.data?.message || err.message}`);
      return [];
    }
  }

  async deleteCard(userId: string, cardId: string): Promise<boolean> {
    const user = await this.appUsersService.findById(userId);
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (!user.pagarmeCustomerId) throw new BadRequestException('Nenhum cartao cadastrado');

    try {
      await this.pagarmeDelete(`/customers/${user.pagarmeCustomerId}/cards/${cardId}`);
      return true;
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Failed to delete card: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao remover cartao');
    }
  }

  // ─── Direct Charge (saved card) ────────────────────────────────────

  async createOrderDirectCharge(order: Order, customer: AppUser, cardId?: string, cardToken?: string): Promise<{ pagarmeOrderId: string; status: string }> {
    const store = order.store;
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    const platformRecipientId = this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID');

    const customerId = await this.ensureCustomer(customer);
    const totalCents = Math.round(Number(order.total) * 100);
    const splitRules = (vendorRecipientId && platformRecipientId)
      ? await this.buildSplitRules(order, store, vendorRecipientId, platformRecipientId)
      : [];

    const phoneDigits = customer.phone?.replace(/\D/g, '') || '';
    const ddd = phoneDigits.length >= 11 ? phoneDigits.substring(0, 2) : '53';
    const phoneNumber = phoneDigits.length >= 11 ? phoneDigits.substring(2) : phoneDigits;

    const orderBody: any = {
      code: `order-${order.id}`,
      items: [
        {
          amount: totalCents,
          description: `Pedido ${order.orderNumber}`.substring(0, 256),
          quantity: 1,
          code: `order-${order.id}`,
        },
      ],
      customer: {
        id: customerId,
        name: customer.name,
        email: customer.email,
        type: 'individual',
        document: customer.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        phones: {
          mobile_phone: {
            country_code: '55',
            area_code: ddd,
            number: phoneNumber || '999999999',
          },
        },
      },
      payments: [
        {
          payment_method: 'credit_card',
          credit_card: {
            installments: 1,
            statement_descriptor: 'BCMTECH',
            capture: true,
            ...(cardToken ? { card_token: cardToken } : { card_id: cardId }),
          },
          ...(splitRules.length > 0 ? { split: splitRules } : {}),
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
      this.logger.log(
        `Pagar.me direct charge for ${order.orderNumber} | total: ${order.total} | pagarme_order: ${result.id} | split: ${splitRules.length > 0}`,
      );
      const charge = result.charges?.[0];
      const status = charge?.status || result.status || 'pending';
      return { pagarmeOrderId: result.id, status };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me direct charge failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(
        errorData?.message || 'Erro ao cobrar cartao salvo',
      );
    }
  }

  // ─── Order Checkout (Credit Card via Pagar.me) ─────────────────────────

  async createOrderCheckout(order: Order, customer: AppUser): Promise<{ checkoutUrl: string; preferenceId: string }> {
    const store = order.store;
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    const platformRecipientId = this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID');

    await this.getOrCreatePagarmeCustomer(customer);

    // Build split rules (skip if recipients not configured)
    const splitRules = (vendorRecipientId && platformRecipientId)
      ? await this.buildSplitRules(order, store, vendorRecipientId, platformRecipientId)
      : [];

    const totalCents = Math.round(Number(order.total) * 100);

    const itemsSummary = order.items
      .map((item) => {
        const name = item.product?.name || 'Produto';
        if (item.weightGrams && item.weightGrams > 0) {
          return `${name} (${item.weightGrams}g)`;
        }
        return `${item.quantity}x ${name}`;
      })
      .join(', ');

    // Customer data for PSP (mandatory)
    const phoneDigits = customer.phone?.replace(/\D/g, '') || '';
    const ddd = phoneDigits.length >= 11 ? phoneDigits.substring(0, 2) : '53';
    const phoneNumber = phoneDigits.length >= 11 ? phoneDigits.substring(2) : phoneDigits;

    const customerObj: any = {
      name: customer.name,
      email: customer.email,
      type: 'individual',
      document: customer.cpf?.replace(/\D/g, '') || '',
      document_type: 'CPF',
      phones: {
        mobile_phone: {
          country_code: '55',
          area_code: ddd,
          number: phoneNumber || '999999999',
        },
      },
    };

    // Create Pagar.me order without payment (open order) — payment will be
    // collected via the hosted checkout page (payment link)
    const orderBody: any = {
      code: `order-${order.id}`,
      items: [
        {
          amount: totalCents,
          description: `Pedido ${order.orderNumber} - ${itemsSummary}`.substring(0, 256),
          quantity: 1,
          code: `order-${order.id}`,
        },
      ],
      customer: customerObj,
      metadata: {
        order_id: order.id,
        order_number: order.orderNumber,
      },
      closed: false,
    };

    try {
      const result = await this.pagarmePost('/orders', orderBody);

      this.logger.log(
        `Pagar.me order created for ${order.orderNumber} | total: ${order.total} | pagarme_order: ${result.id}`,
      );

      // Create hosted checkout page where customer can enter card details
      const checkoutUrl = await this.createPaymentLink(order, totalCents, splitRules);

      return { checkoutUrl, preferenceId: result.id };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me order failed: ${JSON.stringify(errorData || err.message)}`);
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

    const totalCents = Math.round(Number(order.total) * 100);
    const splitRules = (vendorRecipientId && platformRecipientId)
      ? await this.buildSplitRules(order, store, vendorRecipientId, platformRecipientId)
      : [];

    const phoneDigits = customer.phone?.replace(/\D/g, '') || '';
    const ddd = phoneDigits.length >= 11 ? phoneDigits.substring(0, 2) : '53';
    const phoneNumber = phoneDigits.length >= 11 ? phoneDigits.substring(2) : phoneDigits;

    const orderBody: any = {
      code: `order-${order.id}`,
      items: [
        {
          amount: totalCents,
          description: `Pedido ${order.orderNumber} (PIX)`.substring(0, 256),
          quantity: 1,
          code: `order-${order.id}`,
        },
      ],
      customer: {
        name: customer.name,
        email: customer.email,
        type: 'individual',
        document: customer.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        phones: {
          mobile_phone: {
            country_code: '55',
            area_code: ddd,
            number: phoneNumber || '999999999',
          },
        },
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
          ...(splitRules.length > 0 ? { split: splitRules } : {}),
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

  // ─── Payment Link (hosted checkout) ────────────────────────────────────

  private async createPaymentLink(order: Order, totalCents: number, splitRules: any[]): Promise<string> {
    const body = {
      name: `Pedido ${order.orderNumber}`,
      amount: totalCents,
      payment_settings: {
        accepted_payment_methods: ['credit_card', 'pix'],
        credit_card: {
          installments: [{ number: 1, total: totalCents }],
          statement_descriptor: 'BCMTECH',
        },
        pix: {
          expires_in: 1800,
        },
      },
      ...(splitRules.length > 0 ? { split: splitRules } : {}),
      metadata: {
        order_id: order.id,
        order_number: order.orderNumber,
      },
    };

    try {
      const result = await this.pagarmePost('/paymentlinks', body);
      // Payment link URL format: https://pagar.me/pay/{id}
      return result.url || `https://pagar.me/pay/${result.id}`;
    } catch (err: any) {
      this.logger.warn(`Payment link creation failed, falling back to direct order: ${err.response?.data?.message || err.message}`);
      // If payment link fails, return empty (order was already created)
      return '';
    }
  }

  // ─── Split Rules Builder ───────────────────────────────────────────────

  private async buildSplitRules(order: Order, store: Store, vendorRecipientId: string, platformRecipientId: string): Promise<any[]> {
    const totalCents = Math.round(Number(order.total) * 100);
    const commissionCents = Math.round((Number(order.commissionAmount) || 0) * 100);
    const deliveryFeeCents = Math.round((Number(order.deliveryFee) || 0) * 100);

    const splitRules: any[] = [];

    // Deliverer split: gets delivery fee minus platform commission on delivery
    let delivererCents = 0;
    let deliveryCommissionCents = 0;
    const delivery = (order as any).delivery;
    const delivererRecipientId = delivery?.deliverer?.pagarmeRecipientId;
    const deliveryCommissionPercent = await this.platformConfigService.getDeliveryCommissionPercent();

    if (!store?.hasOwnDelivery && deliveryFeeCents > 0 && delivererRecipientId) {
      deliveryCommissionCents = Math.round(deliveryFeeCents * (deliveryCommissionPercent / 100));
      delivererCents = deliveryFeeCents - deliveryCommissionCents;
      splitRules.push({
        amount: delivererCents,
        recipient_id: delivererRecipientId,
        type: 'flat',
        options: {
          charge_processing_fee: false,
          charge_remainder_fee: false,
          liable: false,
        },
      });
    }

    // Platform split: gets sales commission + delivery commission
    const platformCents = commissionCents + deliveryCommissionCents + ((!store?.hasOwnDelivery && !delivererRecipientId) ? deliveryFeeCents : 0);
    if (platformCents > 0) {
      splitRules.push({
        amount: platformCents,
        recipient_id: platformRecipientId,
        type: 'flat',
        options: {
          charge_processing_fee: false,
          charge_remainder_fee: true,
          liable: false,
        },
      });
    }

    // Vendor split: gets the rest (total - commission - deliverer fee), pays processing fees
    // Vendor is liable for chargebacks (e.g. customer disputes due to food quality)
    const vendorCents = totalCents - platformCents - delivererCents;
    if (vendorCents > 0) {
      splitRules.push({
        amount: vendorCents,
        recipient_id: vendorRecipientId,
        type: 'flat',
        options: {
          charge_processing_fee: true,
          charge_remainder_fee: false,
          liable: true,
        },
      });
    }

    return splitRules;
  }

  // ─── Plan Upgrade ──────────────────────────────────────────────────────

  async createPlanUpgrade(user: VendorUser, plan: VendorPlan, billingPeriod: string = 'monthly'): Promise<Payment> {
    const planConfig = PLAN_CONFIGS[plan];
    if (!planConfig || planConfig.monthlyPrice === 0) {
      throw new BadRequestException('Plano invalido para upgrade');
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
    const body = {
      name: `Plano ${plan} ${billing.label} - bcmTech Delivery`,
      amount: totalCents,
      payment_settings: {
        accepted_payment_methods: ['credit_card', 'pix'],
        credit_card: {
          installments: Array.from({ length: Math.min(billing.months, 12) }, (_, i) => ({
            number: i + 1,
            total: totalCents,
          })),
          statement_descriptor: 'BCMTECH',
        },
        pix: {
          expires_in: 86400, // 24 hours
        },
      },
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

    const body = {
      name: `Promoção: ${promotion.title}`,
      amount: totalCents,
      payment_settings: {
        accepted_payment_methods: ['credit_card', 'pix'],
        credit_card: {
          installments: [{ number: 1, total: totalCents }],
          statement_descriptor: 'BCMTECH',
        },
        pix: {
          expires_in: 86400,
        },
      },
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

  async registerVendorRecipient(userId: string, recipientData: any): Promise<{ recipientId: string }> {
    const vendor = await this.vendorUsersService.findById(userId);
    if (!vendor) throw new NotFoundException('Vendedor não encontrado');

    const result = await this.createRecipient({
      ...recipientData,
      code: `vendor_${userId}`,
    });

    await this.vendorUsersService.updatePagarmeRecipient(userId, result.id);

    return { recipientId: result.id };
  }

  async registerDelivererRecipient(userId: string, recipientData: any): Promise<{ recipientId: string }> {
    const deliverer = await this.appUsersService.findById(userId);
    if (!deliverer) throw new NotFoundException('Entregador não encontrado');

    const result = await this.createRecipient({
      ...recipientData,
      code: `deliverer_${userId}`,
    });

    await this.appUsersService.updatePagarmeRecipient(userId, result.id);

    return { recipientId: result.id };
  }

  async disconnectVendor(userId: string): Promise<void> {
    await this.vendorUsersService.disconnectPayment(userId);
  }

  async disconnectApp(userId: string): Promise<void> {
    await this.appUsersService.disconnectPayment(userId);
  }

  // ─── Webhook ───────────────────────────────────────────────────────────

  async handleWebhook(body: any): Promise<void> {
    const eventType = body.type;
    const data = body.data;

    if (!data) return;

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
    const orderId = metadata.order_id || (code?.startsWith('order-') ? code.replace('order-', '') : null);
    if (orderId) {
      const orderRepo = this.paymentsRepository.manager.getRepository(Order);
      const order = await orderRepo.findOne({
        where: { id: orderId },
        relations: ['customer', 'store'],
      });

      if (order && order.status === OrderStatus.AWAITING_PAYMENT) {
        order.status = OrderStatus.PENDING;
        await orderRepo.save(order);
        this.logger.log(`Pagamento aprovado para pedido #${order.orderNumber}`);

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
    const metadata = data.metadata || {};
    const orderId = metadata.order_id;
    if (!orderId) return;

    this.logger.warn(`Payment failed for order ${orderId}`);
  }

  private async handleOrderCanceled(data: any): Promise<void> {
    const metadata = data.metadata || {};
    const orderId = metadata.order_id;
    if (!orderId) return;

    this.logger.warn(`Order canceled on Pagar.me: ${orderId}`);
  }

  private async handleChargePaid(data: any): Promise<void> {
    // charge.paid can be used for immediate confirmation
    // The order.paid webhook will also fire, so this is a fallback
    this.logger.log(`Charge paid: ${data.id}`);
  }

  private async handleChargeRefunded(data: any): Promise<void> {
    const metadata = data.metadata || data.order?.metadata || {};
    const orderId = metadata.order_id || (data.code?.startsWith('order-') ? data.code.replace('order-', '') : null);

    this.logger.log(`Charge refunded: ${data.id} | orderId: ${orderId}`);

    if (!orderId) return;

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner'],
    });

    if (order && order.status !== OrderStatus.CANCELLED) {
      order.status = OrderStatus.CANCELLED;
      await orderRepo.save(order);
      this.logger.log(`Pedido #${order.orderNumber} cancelado por estorno`);

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
    const orderId = metadata.order_id || (data.code?.startsWith('order-') ? data.code.replace('order-', '') : null);

    this.logger.warn(`Chargeback received: ${data.id} | orderId: ${orderId}`);

    if (!orderId) return;

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner'],
    });

    if (order) {
      order.status = OrderStatus.CANCELLED;
      await orderRepo.save(order);
      this.logger.warn(`Pedido #${order.orderNumber} cancelado por chargeback`);

      // Notify vendor about chargeback
      if (order.store?.owner?.id) {
        this.notificationsService.sendToVendorUser(
          order.store.owner.id,
          'Chargeback recebido',
          `O pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) recebeu uma contestação (chargeback). O valor será debitado da sua conta.`,
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
      relations: ['customer', 'store', 'store.owner'],
    });

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (!order.mpPreferenceId) throw new BadRequestException('Este pedido não possui pagamento online para estornar');
    if (order.status === OrderStatus.CANCELLED) throw new BadRequestException('Este pedido já está cancelado');

    try {
      // Get the order from Pagar.me to find the charge ID
      const pagarmeOrder = await this.pagarmeGet(`/orders/${order.mpPreferenceId}`);
      const charge = pagarmeOrder.charges?.[0];

      if (!charge) throw new BadRequestException('Cobrança não encontrada no Pagar.me');
      if (charge.status !== 'paid') throw new BadRequestException(`Cobrança com status "${charge.status}" não pode ser estornada`);

      // Request refund
      await this.pagarmePost(`/charges/${charge.id}/refund`, {
        amount: charge.amount,
      });

      order.status = OrderStatus.CANCELLED;
      await orderRepo.save(order);

      this.logger.log(`Refund requested for order #${order.orderNumber} | charge: ${charge.id}`);

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

  async getRecipientBalance(recipientId: string): Promise<{ availableAmount: number; waitingFundsAmount: number; transferredAmount: number }> {
    try {
      const result = await this.pagarmeGet(`/recipients/${recipientId}/balance`);
      return {
        availableAmount: (result.available_amount || 0) / 100,
        waitingFundsAmount: (result.waiting_funds?.amount || 0) / 100,
        transferredAmount: (result.transferred_amount || 0) / 100,
      };
    } catch (err: any) {
      this.logger.warn(`Failed to get recipient balance: ${err.response?.data?.message || err.message}`);
      return { availableAmount: 0, waitingFundsAmount: 0, transferredAmount: 0 };
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
      const result = await this.pagarmePost(`/recipients/${recipientId}/anticipations`, {
        payment_date: new Date().toISOString().split('T')[0],
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
      await this.pagarmePut(`/recipients/${recipientId}`, {
        automatic_anticipation_settings: {
          enabled,
          type: enabled ? 'full' : undefined,
          volume_percentage: enabled ? 100 : undefined,
          delay: enabled ? 0 : undefined,
        },
      });
      return true;
    } catch (err: any) {
      this.logger.error(`Failed to update anticipation settings: ${err.response?.data?.message || err.message}`);
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

  async findAll(): Promise<Payment[]> {
    return this.paymentsRepository.find({
      relations: ['appUser', 'vendorUser'],
      order: { createdAt: 'DESC' },
    });
  }

  async platformRevenue(): Promise<number> {
    const result = await this.paymentsRepository
      .createQueryBuilder('payment')
      .select('COALESCE(SUM(payment.amount), 0)', 'total')
      .where('payment.status = :status', { status: 'approved' })
      .andWhere('payment.type IN (:...types)', { types: ['PLAN_UPGRADE', 'PROMOTION'] })
      .getRawOne();
    return parseFloat(result.total);
  }
}
