import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference, Payment as MpPayment } from 'mercadopago';
import { Payment } from './entities/payment.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { VendorPlan } from '../common/enums';
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
        },
        ...(this.configService.get('APP_URL') ? {
          back_urls: {
            success: `${this.configService.get('APP_URL')}/dashboard/plan?status=success`,
            failure: `${this.configService.get('APP_URL')}/dashboard/plan?status=failure`,
            pending: `${this.configService.get('APP_URL')}/dashboard/plan?status=pending`,
          },
          auto_return: 'approved' as const,
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

  async handleWebhook(body: any): Promise<void> {
    if (body.type !== 'payment' && body.action !== 'payment.created') {
      return;
    }

    const paymentId = body.data?.id;
    if (!paymentId) return;

    const mpPayment = new MpPayment(this.mpClient);
    const mpData = await mpPayment.get({ id: paymentId });

    if (!mpData || !mpData.external_reference) return;

    const [userId, plan, months] = mpData.external_reference.split(':');
    const status = mpData.status; // approved, pending, rejected

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
