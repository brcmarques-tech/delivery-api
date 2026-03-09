import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference, Payment as MpPayment, Customer } from 'mercadopago';
import { Payment } from './entities/payment.entity';
import { User } from '../users/entities/user.entity';
import { Order } from '../orders/entities/order.entity';
import { Promotion } from '../promotions/entities/promotion.entity';
import { UsersService } from '../users/users.service';
import { VendorPlan, OrderStatus } from '../common/enums';
import { PLAN_CONFIGS } from '../common/plan-config';

@Injectable()
export class PaymentsService {
  private mpClient: MercadoPagoConfig;

  constructor(
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    this.mpClient = new MercadoPagoConfig({
      accessToken: this.configService.get('MP_ACCESS_TOKEN') || '',
    });
  }

  async createPlanUpgrade(user: User, plan: VendorPlan): Promise<Payment> {
    const planConfig = PLAN_CONFIGS[plan];
    if (!planConfig || planConfig.monthlyPrice === 0) {
      throw new BadRequestException('Plano invalido para upgrade');
    }

    const mpCustomerId = await this.getOrCreateMpCustomer(user);
    const preference = new Preference(this.mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            id: `plan-${plan}`,
            title: `Plano ${plan} - bcmTech Delivery`,
            description: `Assinatura mensal do plano ${plan}`,
            quantity: 1,
            unit_price: planConfig.monthlyPrice,
            currency_id: 'BRL',
          },
        ],
        payer: {
          email: user.email,
          name: user.name,
          ...(mpCustomerId ? { id: mpCustomerId } : {}),
        },
        ...(this.configService.get('APP_URL') ? {
          back_urls: {
            success: `${this.configService.get('APP_URL')}/dashboard/plan?status=success`,
            failure: `${this.configService.get('APP_URL')}/dashboard/plan?status=failure`,
            pending: `${this.configService.get('APP_URL')}/dashboard/plan?status=pending`,
          },
        } : {}),
        external_reference: `${user.id}:${plan}:1`,
        notification_url: `${this.configService.get('WEBHOOK_URL') || 'http://localhost:3000'}/payments/webhook`,
      },
    });

    const payment = this.paymentsRepository.create({
      type: 'PLAN_UPGRADE',
      description: `Upgrade para plano ${plan}`,
      amount: planConfig.monthlyPrice,
      status: 'pending',
      mpPreferenceId: result.id,
      checkoutUrl: result.init_point,
      metadata: { plan, durationMonths: 1 },
      user,
    });

    return this.paymentsRepository.save(payment);
  }

  private async getOrCreateMpCustomer(user: User): Promise<string | undefined> {
    if (user.mpCustomerId) return user.mpCustomerId;

    try {
      const customerApi = new Customer(this.mpClient);

      // Search existing customer by email
      const search = await customerApi.search({ options: { email: user.email } });
      if (search.results && search.results.length > 0) {
        const mpCustomerId = search.results[0].id!;
        await this.usersService.updateMpCustomerId(user.id, mpCustomerId);
        return mpCustomerId;
      }

      // Create new customer
      const created = await customerApi.create({
        body: {
          email: user.email,
          first_name: user.name.split(' ')[0],
          last_name: user.name.split(' ').slice(1).join(' ') || undefined,
        },
      });
      if (created.id) {
        await this.usersService.updateMpCustomerId(user.id, created.id);
        return created.id;
      }
    } catch {
      // Non-critical — proceed without saved cards
    }
    return undefined;
  }

  async createPromotionCheckout(promotion: Promotion, user: User): Promise<Payment> {
    const mpCustomerId = await this.getOrCreateMpCustomer(user);
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
          },
        ],
        payer: {
          email: user.email,
          name: user.name,
          ...(mpCustomerId ? { id: mpCustomerId } : {}),
        },
        ...(this.configService.get('VENDOR_APP_URL') ? {
          back_urls: {
            success: `${this.configService.get('VENDOR_APP_URL')}/dashboard/promotions?status=success`,
            failure: `${this.configService.get('VENDOR_APP_URL')}/dashboard/promotions?status=failure`,
            pending: `${this.configService.get('VENDOR_APP_URL')}/dashboard/promotions?status=pending`,
          },
        } : {}),
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
      user,
    });

    return this.paymentsRepository.save(payment);
  }

  async createOrderCheckout(order: Order, customer: User): Promise<{ checkoutUrl: string; preferenceId: string }> {
    const mpCustomerId = await this.getOrCreateMpCustomer(customer);

    // Determine payment flow:
    // - Own delivery / pickup + vendor has MP: marketplace split (vendor gets paid immediately)
    // - App deliverer: platform receives everything (escrow), pays vendor on pickup, deliverer on customer confirmation
    const store = order.store;
    const vendorToken = store?.owner?.mpAccessToken;
    const hasOwnDelivery = store?.hasOwnDelivery;
    const isAppDeliverer = !hasOwnDelivery && !order.isPickup;

    // Only use marketplace split for own-delivery/pickup orders
    const useMarketplace = !!vendorToken && !isAppDeliverer;
    const client = useMarketplace
      ? new MercadoPagoConfig({ accessToken: vendorToken })
      : this.mpClient;

    const preference = new Preference(client);

    const result = await preference.create({
      body: {
        items: order.items.map((item) => ({
          id: item.product?.id || item.id,
          title: item.product?.name || 'Produto',
          quantity: item.quantity,
          unit_price: Number(item.unitPrice),
          currency_id: 'BRL',
        })),
        payer: {
          email: customer.email,
          name: customer.name,
          ...(mpCustomerId ? { id: mpCustomerId } : {}),
        },
        external_reference: `order:${order.id}`,
        notification_url: `${this.configService.get('WEBHOOK_URL') || 'http://localhost:3000'}/payments/webhook`,
      },
    });

    return { checkoutUrl: result.init_point!, preferenceId: result.id! };
  }

  async createOrderPix(order: Order, customer: User): Promise<{ qrCode: string; qrCodeBase64: string }> {
    // Same escrow logic as checkout: app deliverer orders go through platform account
    const store = order.store;
    const vendorToken = store?.owner?.mpAccessToken;
    const hasOwnDelivery = store?.hasOwnDelivery;
    const isAppDeliverer = !hasOwnDelivery && !order.isPickup;

    const useMarketplace = !!vendorToken && !isAppDeliverer;
    const client = useMarketplace
      ? new MercadoPagoConfig({ accessToken: vendorToken })
      : this.mpClient;

    const mpPayment = new MpPayment(client);
    const result = await mpPayment.create({
      body: {
        transaction_amount: Number(order.total),
        description: `Pedido ${order.orderNumber}`,
        payment_method_id: 'pix',
        payer: {
          email: customer.email,
          first_name: customer.name.split(' ')[0],
          last_name: customer.name.split(' ').slice(1).join(' ') || customer.name,
        },
        external_reference: `order:${order.id}`,
        notification_url: `${this.configService.get('WEBHOOK_URL') || 'http://localhost:3000'}/payments/webhook`,
      },
    });

    const qrCode = (result as any).point_of_interaction?.transaction_data?.qr_code || '';
    const qrCodeBase64 = (result as any).point_of_interaction?.transaction_data?.qr_code_base64 || '';

    return { qrCode, qrCodeBase64 };
  }

  getMpConnectUrl(userId: string, source: string = 'web'): string {
    const appId = this.configService.get('MP_APP_ID');
    const webhookUrl = this.configService.get('WEBHOOK_URL') || 'http://localhost:3000';
    const redirectUri = `${webhookUrl}/payments/mp/callback`;
    const state = `${userId}:${source}`;
    return `https://auth.mercadopago.com.br/authorization?client_id=${appId}&response_type=code&platform_id=mp&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async handleMpOAuthCallback(code: string, userId: string): Promise<void> {
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
      await this.usersService.updateMpCredentials(
        userId,
        data.access_token,
        data.refresh_token,
        String(data.user_id),
      );
      console.log('MP credentials saved for user:', userId);
    } else {
      console.error('MP OAuth failed:', data);
    }
  }

  async disconnectMp(userId: string): Promise<void> {
    await this.usersService.disconnectMp(userId);
  }

  async handleWebhook(body: any): Promise<void> {
    if (body.type !== 'payment' && body.action !== 'payment.created') {
      return;
    }

    const paymentId = body.data?.id;
    if (!paymentId) return;

    const mpPayment = new MpPayment(this.mpClient);
    const mpData = await mpPayment.get({ id: paymentId });

    if (!mpData || !mpData.external_reference) return;

    const externalRef = mpData.external_reference;
    const status = mpData.status; // approved, pending, rejected

    // Handle order payment
    if (externalRef.startsWith('order:')) {
      const orderId = externalRef.replace('order:', '');
      if (status === 'approved') {
        const orderRepo = this.paymentsRepository.manager.getRepository(Order);
        const order = await orderRepo.findOne({ where: { id: orderId } });
        if (order && order.status === OrderStatus.AWAITING_PAYMENT) {
          order.status = OrderStatus.PENDING;
          await orderRepo.save(order);
        }
      }
      return;
    }

    // Handle promotion payment
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
          // Apply promotional price to the product
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
      // Update payment record
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

    // Find or update payment record
    const prefId = (mpData as any).preference_id;
    if (prefId) {
      const payment = await this.paymentsRepository.findOne({
        where: { mpPreferenceId: prefId },
        relations: ['user'],
      });

      if (payment) {
        payment.mpPaymentId = String(paymentId);
        payment.status = status || 'pending';
        await this.paymentsRepository.save(payment);
      }
    }

    // If approved, activate the plan
    if (status === 'approved') {
      await this.usersService.updateVendorPlan(
        userId,
        plan as VendorPlan,
        parseInt(months) || 1,
      );
    }
  }

  async transferToVendor(vendorId: string, amount: number, orderId: string): Promise<{ success: boolean; mpId?: string }> {
    const vendor = await this.usersService.findById(vendorId);
    if (!vendor?.mpUserId) {
      return { success: false };
    }

    try {
      const response = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.configService.get('MP_ACCESS_TOKEN')}`,
        },
        body: JSON.stringify({
          transaction_amount: amount,
          description: `Pagamento pedido ${orderId}`,
          payment_method_id: 'account_money',
          payer: {
            email: 'platform@bcmtech.com',
          },
          collector_id: Number(vendor.mpUserId),
          external_reference: `vendor-payout:${orderId}:${vendorId}`,
        }),
      });

      const data = await response.json();

      if (data.id && (data.status === 'approved' || data.status === 'pending')) {
        const payment = this.paymentsRepository.create({
          type: 'VENDOR_PAYOUT',
          description: `Repasse vendedor - Pedido ${orderId}`,
          amount,
          status: data.status,
          mpPaymentId: String(data.id),
          user: vendor,
        });
        await this.paymentsRepository.save(payment);
        return { success: true, mpId: String(data.id) };
      }

      return { success: false };
    } catch (err) {
      console.error('Failed to transfer to vendor:', err);
      return { success: false };
    }
  }

  async transferToDeliverer(delivererId: string, amount: number, orderId: string): Promise<{ success: boolean; mpId?: string }> {
    // Fetch the deliverer to get mpUserId
    const deliverer = await this.usersService.findById(delivererId);
    if (!deliverer?.mpUserId) {
      return { success: false };
    }

    try {
      // Use MP API to transfer from platform to deliverer
      const response = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.configService.get('MP_ACCESS_TOKEN')}`,
        },
        body: JSON.stringify({
          transaction_amount: amount,
          description: `Entrega do pedido ${orderId}`,
          payment_method_id: 'account_money',
          payer: {
            email: 'platform@bcmtech.com',
          },
          collector_id: Number(deliverer.mpUserId),
          external_reference: `payout:${orderId}:${delivererId}`,
        }),
      });

      const data = await response.json();

      if (data.id && (data.status === 'approved' || data.status === 'pending')) {
        // Save payment record for audit
        const payment = this.paymentsRepository.create({
          type: 'DELIVERER_PAYOUT',
          description: `Repasse entrega - Pedido ${orderId}`,
          amount,
          status: data.status,
          mpPaymentId: String(data.id),
          user: deliverer,
        });
        await this.paymentsRepository.save(payment);

        return { success: true, mpId: String(data.id) };
      }

      return { success: false };
    } catch (err) {
      console.error('Failed to transfer to deliverer:', err);
      return { success: false };
    }
  }

  async findByUser(userId: string): Promise<Payment[]> {
    return this.paymentsRepository.find({
      where: { user: { id: userId } },
      order: { createdAt: 'DESC' },
    });
  }

  async findAll(): Promise<Payment[]> {
    return this.paymentsRepository.find({
      relations: ['user'],
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
