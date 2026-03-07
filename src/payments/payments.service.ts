import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference, Payment as MpPayment, Customer } from 'mercadopago';
import { Payment } from './entities/payment.entity';
import { User } from '../users/entities/user.entity';
import { Order } from '../orders/entities/order.entity';
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

  async createOrderCheckout(order: Order, customer: User): Promise<{ checkoutUrl: string; preferenceId: string }> {
    const mpCustomerId = await this.getOrCreateMpCustomer(customer);
    const preference = new Preference(this.mpClient);
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
    const mpPayment = new MpPayment(this.mpClient);
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
}
