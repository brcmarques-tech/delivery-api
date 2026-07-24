import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Not, IsNull } from 'typeorm';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { Subscription } from './entities/subscription.entity';
import { VendorPlan } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

const CHECK_INTERVAL_MS = 60_000; // 60 seconds

@Injectable()
export class SubscriptionExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionExpiryScheduler.name);
  private intervalRef: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(VendorUser)
    private vendorUsersRepository: Repository<VendorUser>,
    @InjectRepository(Subscription)
    private subscriptionsRepository: Repository<Subscription>,
    private notificationsService: NotificationsService,
    private whatsAppService: WhatsAppService,
  ) {}

  onModuleInit() {
    // KAN-253: a Promise de `checkExpiredPlans()` era descartada. Se algo
    // escapar do try/catch interno, vira unhandled rejection (que pode derrubar
    // o processo dependendo da config do Node). Com o `.catch`, uma rodada com
    // problema apenas loga e o scheduler continua vivo.
    this.intervalRef = setInterval(() => {
      this.checkExpiredPlans().catch((err) =>
        this.logger.error('checkExpiredPlans falhou:', err),
      );
    }, CHECK_INTERVAL_MS);
    this.logger.log('Subscription expiry scheduler started (60s interval)');
  }

  onModuleDestroy() {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }
  }

  private async checkExpiredPlans(): Promise<void> {
    try {
      const now = new Date();

      // Find vendors with expired plans that are not FREE
      const expiredVendors = await this.vendorUsersRepository.find({
        where: {
          vendorPlan: Not(VendorPlan.FREE),
          planExpiresAt: LessThan(now),
        },
      });

      for (const vendor of expiredVendors) {
        // Check if vendor has an active subscription — if so, skip (webhook will handle renewal)
        const activeSubscription = await this.subscriptionsRepository.findOne({
          where: {
            vendorUser: { id: vendor.id },
            status: 'active',
          },
        });

        if (activeSubscription) {
          this.logger.debug(`Vendor ${vendor.id} has active subscription, skipping expiry`);
          continue;
        }

        // Also check cancelAtPeriodEnd subscriptions
        const pendingCancel = await this.subscriptionsRepository.findOne({
          where: {
            vendorUser: { id: vendor.id },
            cancelAtPeriodEnd: true,
            status: Not('canceled'),
          },
        });

        // Downgrade to FREE
        const previousPlan = vendor.vendorPlan;
        vendor.vendorPlan = VendorPlan.FREE;
        vendor.planExpiresAt = null;
        vendor.pagarmeSubscriptionId = null as any;
        await this.vendorUsersRepository.save(vendor);

        // Mark pending cancel subscription as canceled
        if (pendingCancel) {
          pendingCancel.status = 'canceled';
          pendingCancel.canceledAt = new Date();
          await this.subscriptionsRepository.save(pendingCancel);
        }

        this.logger.log(`Vendor ${vendor.id} plan expired: ${previousPlan} → FREE`);

        // Notify
        if (vendor.phone) {
          this.whatsAppService.sendText(
            vendor.phone,
            `⚠️ *Plano expirado*\n\nSua assinatura do plano ${previousPlan} expirou e seu plano foi alterado para FREE.\n\nPara continuar usando os recursos premium, renove sua assinatura no painel.`,
          ).catch(() => {});
        }
        this.notificationsService.sendToVendorUser(
          vendor.id,
          'Plano expirado',
          `Sua assinatura do plano ${previousPlan} expirou. Renove para manter os recursos premium.`,
          { type: 'PLAN_EXPIRED', previousPlan },
        ).catch(() => {});
      }
    } catch (err: any) {
      this.logger.error(`Subscription expiry check failed: ${err.message}`);
    }
  }
}
