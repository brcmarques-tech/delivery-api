import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference, Payment as MpPayment, Customer } from 'mercadopago';
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
  private mpClient: MercadoPagoConfig;

  constructor(
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    private configService: ConfigService,
    @Inject(forwardRef(() => AppUsersService))
    private appUsersService: AppUsersService,
    @Inject(forwardRef(() => VendorUsersService))
    private vendorUsersService: VendorUsersService,
    private platformConfigService: PlatformConfigService,
    private whatsAppService: WhatsAppService,
    private notificationsService: NotificationsService,
  ) {
    this.mpClient = new MercadoPagoConfig({
      accessToken: this.configService.get('MP_ACCESS_TOKEN') || '',
    });
  }

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

    const maxInstallments = billing.months >= 12 ? 12 : billing.months >= 6 ? 6 : billing.months >= 3 ? 3 : 1;

    const mpCustomerId = await this.getOrCreateMpCustomerVendor(user);
    const preference = new Preference(this.mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            id: `plan-${plan}-${billingPeriod}`,
            title: `Plano ${plan} ${billing.label} - bcmTech Delivery`,
            description: `Assinatura ${billing.label.toLowerCase()} do plano ${plan} (${billing.months} meses)`,
            quantity: 1,
            unit_price: billing.price,
            currency_id: 'BRL',
            category_id: 'services',
          },
        ],
        payer: {
          email: user.email,
          first_name: user.name.split(' ')[0],
          last_name: user.name.split(' ').slice(1).join(' ') || user.name.split(' ')[0],
          ...(mpCustomerId ? { id: mpCustomerId } : {}),
        } as any,
        payment_methods: {
          installments: maxInstallments,
        },
        back_urls: {
          success: `${this.configService.get('VENDOR_APP_URL') || 'http://localhost:3001'}/dashboard/plan?status=success`,
          failure: `${this.configService.get('VENDOR_APP_URL') || 'http://localhost:3001'}/dashboard/plan?status=failure`,
          pending: `${this.configService.get('VENDOR_APP_URL') || 'http://localhost:3001'}/dashboard/plan?status=pending`,
        },
        auto_return: 'approved',
        statement_descriptor: 'BCMTECH DELIVERY',
        external_reference: `${user.id}:${plan}:${billing.months}`,
        notification_url: `${this.configService.get('WEBHOOK_URL') || 'http://localhost:3000'}/payments/webhook`,
      },
    });

    const payment = this.paymentsRepository.create({
      type: 'PLAN_UPGRADE',
      description: `Upgrade para plano ${plan} (${billing.label})`,
      amount: billing.price,
      status: 'pending',
      mpPreferenceId: result.id,
      checkoutUrl: result.init_point,
      metadata: { plan, durationMonths: billing.months, billingPeriod },
      vendorUser: user,
    });

    const saved = await this.paymentsRepository.save(payment);

    if (user.phone) {
      this.whatsAppService.notifyPlanUpgrade(user.phone, user.name, plan, billing.label).catch(() => {});
    }

    return saved;
  }

  private async getOrCreateMpCustomerVendor(user: VendorUser): Promise<string | undefined> {
    if (user.mpCustomerId) return user.mpCustomerId;

    try {
      const customerApi = new Customer(this.mpClient);
      const search = await customerApi.search({ options: { email: user.email } });
      if (search.results && search.results.length > 0) {
        const mpCustomerId = search.results[0].id!;
        await this.vendorUsersService.updateMpCustomerId(user.id, mpCustomerId);
        return mpCustomerId;
      }
      const created = await customerApi.create({
        body: {
          email: user.email,
          first_name: user.name.split(' ')[0],
          last_name: user.name.split(' ').slice(1).join(' ') || undefined,
        },
      });
      if (created.id) {
        await this.vendorUsersService.updateMpCustomerId(user.id, created.id);
        return created.id;
      }
    } catch {}
    return undefined;
  }

  private async getOrCreateMpCustomerApp(user: AppUser): Promise<string | undefined> {
    if (user.mpCustomerId) return user.mpCustomerId;

    try {
      const customerApi = new Customer(this.mpClient);
      const search = await customerApi.search({ options: { email: user.email } });
      if (search.results && search.results.length > 0) {
        const mpCustomerId = search.results[0].id!;
        await this.appUsersService.updateMpCustomerId(user.id, mpCustomerId);
        return mpCustomerId;
      }
      const created = await customerApi.create({
        body: {
          email: user.email,
          first_name: user.name.split(' ')[0],
          last_name: user.name.split(' ').slice(1).join(' ') || undefined,
        },
      });
      if (created.id) {
        await this.appUsersService.updateMpCustomerId(user.id, created.id);
        return created.id;
      }
    } catch {}
    return undefined;
  }

  async createPromotionCheckout(promotion: Promotion, user: VendorUser): Promise<Payment> {
    const mpCustomerId = await this.getOrCreateMpCustomerVendor(user);
    const preference = new Preference(this.mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            id: `promo-${promotion.id}`,
            title: `Promoção: ${promotion.title}`,
            description: `Anúncio no app por ${Math.ceil((new Date(promotion.endDate).getTime() - new Date(promotion.startDate).getTime()) / (1000 * 60 * 60 * 24)) + 1} dias`,
            quantity: 1,
            unit_price: Number(promotion.adCost),
            currency_id: 'BRL',
            category_id: 'services',
          },
        ],
        payer: {
          email: user.email,
          first_name: user.name.split(' ')[0],
          last_name: user.name.split(' ').slice(1).join(' ') || user.name.split(' ')[0],
          ...(mpCustomerId ? { id: mpCustomerId } : {}),
        } as any,
        back_urls: {
          success: `${this.configService.get('VENDOR_APP_URL') || 'http://localhost:3001'}/dashboard/promotions?status=success`,
          failure: `${this.configService.get('VENDOR_APP_URL') || 'http://localhost:3001'}/dashboard/promotions?status=failure`,
          pending: `${this.configService.get('VENDOR_APP_URL') || 'http://localhost:3001'}/dashboard/promotions?status=pending`,
        },
        auto_return: 'approved',
        statement_descriptor: 'BCMTECH DELIVERY',
        external_reference: `promo:${promotion.id}`,
        notification_url: `${this.configService.get('WEBHOOK_URL') || 'http://localhost:3000'}/payments/webhook`,
      },
    });

    const payment = this.paymentsRepository.create({
      type: 'PROMOTION',
      description: `Promoção: ${promotion.title}`,
      amount: Number(promotion.adCost),
      status: 'pending',
      mpPreferenceId: result.id,
      checkoutUrl: result.init_point,
      metadata: { promotionId: promotion.id },
      vendorUser: user,
    });

    return this.paymentsRepository.save(payment);
  }

  async createOrderCheckout(order: Order, customer: AppUser): Promise<{ checkoutUrl: string; preferenceId: string }> {
    const mpCustomerId = await this.getOrCreateMpCustomerApp(customer);

    const store = order.store;
    const vendorToken = store?.owner?.mpAccessToken;

    // Always use vendor's token when available (platform token may be sandbox)
    const client = vendorToken
      ? new MercadoPagoConfig({ accessToken: vendorToken })
      : this.mpClient;

    const preference = new Preference(client);

    const itemsSummary = order.items
      .map((item) => {
        const name = item.product?.name || 'Produto';
        if (item.weightGrams && item.weightGrams > 0) {
          return `${name} (${item.weightGrams}g)`;
        }
        return `${item.quantity}x ${name}`;
      })
      .join(', ');

    // Calculate marketplace fee: commission + delivery fee (when platform handles delivery)
    let marketplaceFee = Number(order.commissionAmount) || 0;
    if (!store?.hasOwnDelivery) {
      marketplaceFee += Number(order.deliveryFee) || 0;
    }

    // Split customer name for MP payer data
    const nameParts = customer.name.trim().split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || firstName;

    // Build payer object with all available data
    const payer: any = {
      email: customer.email,
      first_name: firstName,
      last_name: lastName,
      ...(mpCustomerId ? { id: mpCustomerId } : {}),
    };

    if (customer.cpf) {
      payer.identification = { type: 'CPF', number: customer.cpf.replace(/\D/g, '') };
    }

    if (customer.phone) {
      const phoneDigits = customer.phone.replace(/\D/g, '');
      payer.phone = {
        area_code: phoneDigits.length >= 11 ? phoneDigits.substring(0, 2) : '53',
        number: phoneDigits.length >= 11 ? phoneDigits.substring(2) : phoneDigits,
      };
    }

    if (order.deliveryAddress) {
      payer.address = {
        street_name: order.deliveryAddress,
        zip_code: '96330-000',
      };
    }

    // Preference expires in 24h
    const now = new Date();
    const expiration = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const result = await preference.create({
      body: {
        items: [
          {
            id: `order-${order.id}`,
            title: `Pedido ${order.orderNumber}`,
            description: itemsSummary,
            quantity: 1,
            unit_price: Number(order.total),
            currency_id: 'BRL',
            category_id: 'others',
          },
        ],
        payer,
        ...(vendorToken && marketplaceFee > 0 ? { marketplace_fee: marketplaceFee } : {}),
        back_urls: {
          success: `${this.configService.get('APP_URL') || 'http://localhost:3000'}/payments/order-result?status=success&order=${order.id}`,
          failure: `${this.configService.get('APP_URL') || 'http://localhost:3000'}/payments/order-result?status=failure&order=${order.id}`,
          pending: `${this.configService.get('APP_URL') || 'http://localhost:3000'}/payments/order-result?status=pending&order=${order.id}`,
        },
        auto_return: 'approved',
        binary_mode: true,
        statement_descriptor: 'BCMTECH DELIVERY',
        expires: true,
        date_of_expiration: expiration.toISOString(),
        payment_methods: {
          installments: 6,
        },
        external_reference: `order:${order.id}`,
        notification_url: `${this.configService.get('WEBHOOK_URL') || 'http://localhost:3000'}/payments/webhook`,
      },
    });

    this.logger.log(`Checkout created for order ${order.orderNumber} | total: ${order.total} | marketplace_fee: ${marketplaceFee} | vendor_token: ${!!vendorToken} | owner_id: ${store?.owner?.id || 'none'} | mpAccessToken: ${vendorToken ? vendorToken.substring(0, 20) + '...' : 'none'}`);

    return { checkoutUrl: result.init_point!, preferenceId: result.id! };
  }

  async createOrderPix(order: Order, customer: AppUser): Promise<{ qrCode: string; qrCodeBase64: string }> {
    // Pix always goes to platform account — platform distributes to vendor and deliverer later
    this.logger.log(`Pix creating for order ${order.orderNumber} | total: ${order.total} | using platform token (marketplace model)`);

    const pixNameParts = customer.name.trim().split(' ');
    const pixPayer: any = {
      email: customer.email,
      first_name: pixNameParts[0],
      last_name: pixNameParts.slice(1).join(' ') || pixNameParts[0],
    };

    if (customer.cpf) {
      pixPayer.identification = { type: 'CPF', number: customer.cpf.replace(/\D/g, '') };
    }

    if (customer.phone) {
      const phoneDigits = customer.phone.replace(/\D/g, '');
      pixPayer.phone = {
        area_code: phoneDigits.length >= 11 ? phoneDigits.substring(0, 2) : '53',
        number: phoneDigits.length >= 11 ? phoneDigits.substring(2) : phoneDigits,
      };
    }

    if (order.deliveryAddress) {
      pixPayer.address = {
        street_name: order.deliveryAddress,
        zip_code: '96330-000',
      };
    }

    const pixBody: any = {
      transaction_amount: Number(order.total),
      description: `Pedido ${order.orderNumber}`,
      payment_method_id: 'pix',
      payer: pixPayer,
      binary_mode: true,
      statement_descriptor: 'BCMTECH DELIVERY',
      external_reference: `order:${order.id}`,
      notification_url: `${this.configService.get('WEBHOOK_URL') || 'http://localhost:3000'}/payments/webhook`,
    };

    try {
      const client = new MercadoPagoConfig({ accessToken: this.configService.get('MP_ACCESS_TOKEN') || '' });
      const mpPayment = new MpPayment(client);
      const result = await mpPayment.create({ body: pixBody });

      const qrCode = (result as any).point_of_interaction?.transaction_data?.qr_code || '';
      const qrCodeBase64 = (result as any).point_of_interaction?.transaction_data?.qr_code_base64 || '';

      if (qrCode) {
        this.logger.log(`Pix generated successfully with platform token`);
        return { qrCode, qrCodeBase64 };
      }
      throw new Error('QR code vazio na resposta do Mercado Pago');
    } catch (err: any) {
      this.logger.error(`Pix failed: ${err.message}`);
      throw err;
    }
  }

  getMpConnectUrl(userId: string, source: string = 'web'): string {
    const appId = this.configService.get('MP_APP_ID');
    const webhookUrl = this.configService.get('WEBHOOK_URL') || 'http://localhost:3000';
    const redirectUri = `${webhookUrl}/payments/mp/callback`;
    const state = `${userId}:${source}`;
    return `https://auth.mercadopago.com.br/authorization?client_id=${appId}&response_type=code&platform_id=mp&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async handleMpOAuthCallback(code: string, userId: string, userType: string = 'vendor'): Promise<void> {
    const body = {
      client_secret: this.configService.get('MP_CLIENT_SECRET'),
      client_id: this.configService.get('MP_APP_ID'),
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${this.configService.get('WEBHOOK_URL') || 'http://localhost:3000'}/payments/mp/callback`,
    };
    console.log('MP OAuth request:', JSON.stringify({ ...body, client_secret: body.client_secret?.substring(0, 20) + '...' }));
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    console.log('MP OAuth response:', JSON.stringify(data));

    if (data.access_token) {
      if (userType === 'app') {
        await this.appUsersService.updateMpCredentials(
          userId,
          data.access_token,
          data.refresh_token,
          String(data.user_id),
        );
      } else {
        await this.vendorUsersService.updateMpCredentials(
          userId,
          data.access_token,
          data.refresh_token,
          String(data.user_id),
        );
      }
      console.log('MP credentials saved for user:', userId);
    } else {
      console.error('MP OAuth failed:', data);
    }
  }

  async disconnectMpVendor(userId: string): Promise<void> {
    await this.vendorUsersService.disconnectMp(userId);
  }

  async disconnectMpApp(userId: string): Promise<void> {
    await this.appUsersService.disconnectMp(userId);
  }

  async handleWebhook(body: any): Promise<void> {
    if (body.type !== 'payment' || !['payment.created', 'payment.updated'].includes(body.action)) {
      return;
    }

    const paymentId = body.data?.id;
    if (!paymentId) return;

    const mpPayment = new MpPayment(this.mpClient);
    const mpData = await mpPayment.get({ id: paymentId });

    if (!mpData || !mpData.external_reference) return;

    const externalRef = mpData.external_reference;
    const status = mpData.status;

    if (externalRef.startsWith('order:')) {
      const orderId = externalRef.replace('order:', '');
      if (status === 'approved') {
        const orderRepo = this.paymentsRepository.manager.getRepository(Order);
        const order = await orderRepo.findOne({
          where: { id: orderId },
          relations: ['customer', 'store'],
        });
        if (order && order.status === OrderStatus.AWAITING_PAYMENT) {
          order.status = OrderStatus.PENDING;
          await orderRepo.save(order);
          this.logger.log(`Pagamento aprovado para pedido #${order.orderNumber} (${body.action})`);

          // Notificar cliente
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
      return;
    }

    if (externalRef.startsWith('promo:')) {
      const promotionId = externalRef.replace('promo:', '');
      if (status === 'approved') {
        const promoRepo = this.paymentsRepository.manager.getRepository(Promotion);
        const productRepo = this.paymentsRepository.manager.getRepository('Product');
        const promotion = await promoRepo.findOne({
          where: { id: promotionId },
          relations: ['product'],
        });
        if (promotion && !promotion.isPaid) {
          promotion.isPaid = true;
          await promoRepo.save(promotion);
          if (promotion.product && promotion.promotionalPrice) {
            const now = new Date();
            const start = new Date(promotion.startDate);
            const end = new Date(promotion.endDate);
            if (now >= start && now <= end) {
              await productRepo.update(promotion.product.id, {
                promotionalPrice: promotion.promotionalPrice,
              });
            }
          }
        }
      }
      const prefId = (mpData as any).preference_id;
      if (prefId) {
        const payment = await this.paymentsRepository.findOne({ where: { mpPreferenceId: prefId } });
        if (payment) {
          payment.mpPaymentId = String(paymentId);
          payment.status = status || 'pending';
          await this.paymentsRepository.save(payment);
        }
      }
      return;
    }

    // Handle plan upgrade payment
    const [userId, plan, months] = externalRef.split(':');

    const prefId = (mpData as any).preference_id;
    if (prefId) {
      const payment = await this.paymentsRepository.findOne({
        where: { mpPreferenceId: prefId },
        relations: ['vendorUser'],
      });

      if (payment) {
        payment.mpPaymentId = String(paymentId);
        payment.status = status || 'pending';
        await this.paymentsRepository.save(payment);
      }
    }

    if (status === 'approved') {
      await this.vendorUsersService.updateVendorPlan(
        userId,
        plan as VendorPlan,
        parseInt(months) || 1,
      );
    }
  }

  async transferToVendor(vendorId: string, amount: number, orderId: string): Promise<{ success: boolean; mpId?: string }> {
    const vendor = await this.vendorUsersService.findById(vendorId);
    if (!vendor?.mpUserId) {
      this.logger.warn(`transferToVendor falhou: vendor ${vendorId} sem mpUserId`);
      return { success: false };
    }

    const payerEmail = this.configService.get('MP_PAYER_EMAIL', '');
    if (!payerEmail) {
      this.logger.error('transferToVendor falhou: MP_PAYER_EMAIL não configurado');
      return { success: false };
    }

    const requestBody = {
      transaction_amount: amount,
      description: `Pagamento pedido ${orderId}`,
      payment_method_id: 'account_money',
      payer: {
        email: payerEmail,
      },
      collector_id: Number(vendor.mpUserId),
      external_reference: `vendor-payout:${orderId}:${vendorId}`,
    };

    this.logger.log(`transferToVendor REQUEST: vendor=${vendorId} | mpUserId=${vendor.mpUserId} | amount=R$${amount} | payerEmail=${payerEmail} | orderId=${orderId}`);

    try {
      const response = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.configService.get('MP_ACCESS_TOKEN')}`,
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();
      this.logger.log(`transferToVendor RESPONSE: status=${response.status} | body=${JSON.stringify(data)}`);

      if (data.id && (data.status === 'approved' || data.status === 'pending')) {
        const payment = this.paymentsRepository.create({
          type: 'VENDOR_PAYOUT',
          description: `Repasse vendedor - Pedido ${orderId}`,
          amount,
          status: data.status,
          mpPaymentId: String(data.id),
          vendorUser: vendor,
        });
        await this.paymentsRepository.save(payment);
        this.logger.log(`Repasse vendedor OK: R$${amount} -> vendor ${vendorId} | mpId: ${data.id}`);
        return { success: true, mpId: String(data.id) };
      }

      this.logger.error(`transferToVendor FALHOU: httpStatus=${response.status} | mpStatus=${data.status} | message=${data.message} | cause=${JSON.stringify(data.cause)}`);
      return { success: false };
    } catch (err: any) {
      this.logger.error(`transferToVendor EXCEPTION: ${err.message}`);
      return { success: false };
    }
  }

  async transferToDeliverer(delivererId: string, amount: number, orderId: string): Promise<{ success: boolean; mpId?: string }> {
    const deliverer = await this.appUsersService.findById(delivererId);
    if (!deliverer?.mpUserId) {
      this.logger.warn(`transferToDeliverer falhou: deliverer ${delivererId} sem mpUserId`);
      return { success: false };
    }

    const payerEmail = this.configService.get('MP_PAYER_EMAIL', '');
    if (!payerEmail) {
      this.logger.error('transferToDeliverer falhou: MP_PAYER_EMAIL não configurado');
      return { success: false };
    }

    const requestBody = {
      transaction_amount: amount,
      description: `Entrega do pedido ${orderId}`,
      payment_method_id: 'account_money',
      payer: {
        email: payerEmail,
      },
      collector_id: Number(deliverer.mpUserId),
      external_reference: `payout:${orderId}:${delivererId}`,
    };

    this.logger.log(`transferToDeliverer REQUEST: deliverer=${delivererId} | mpUserId=${deliverer.mpUserId} | amount=R$${amount} | payerEmail=${payerEmail} | orderId=${orderId}`);

    try {
      const response = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.configService.get('MP_ACCESS_TOKEN')}`,
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();
      this.logger.log(`transferToDeliverer RESPONSE: status=${response.status} | body=${JSON.stringify(data)}`);

      if (data.id && (data.status === 'approved' || data.status === 'pending')) {
        const payment = this.paymentsRepository.create({
          type: 'DELIVERER_PAYOUT',
          description: `Repasse entrega - Pedido ${orderId}`,
          amount,
          status: data.status,
          mpPaymentId: String(data.id),
          appUser: deliverer,
        });
        await this.paymentsRepository.save(payment);
        this.logger.log(`Repasse entregador OK: R$${amount} -> deliverer ${delivererId} | mpId: ${data.id}`);
        return { success: true, mpId: String(data.id) };
      }

      this.logger.error(`transferToDeliverer FALHOU: httpStatus=${response.status} | mpStatus=${data.status} | message=${data.message} | cause=${JSON.stringify(data.cause)}`);
      return { success: false };
    } catch (err: any) {
      this.logger.error(`transferToDeliverer EXCEPTION: ${err.message}`);
      return { success: false };
    }
  }

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
