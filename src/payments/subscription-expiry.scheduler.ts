import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Not, IsNull } from 'typeorm';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { Subscription } from './entities/subscription.entity';
import { VendorPlan } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { VendorUsersService } from '../users/vendor-users.service';

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
    private vendorUsersService: VendorUsersService,
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

        // O skip so vale se existe um ciclo PAGO vigente. Antes bastava a string
        // `status = 'active'`, que e escrita por `handleSubscriptionCreated`
        // ANTES de qualquer pagamento e reescrita por `handleSubscriptionUpdated`
        // a cada `subscription.updated` — e no Pagar.me a assinatura segue
        // `active` mesmo com a fatura recusada, porque o status da fatura e
        // independente. Resultado: cartao recusado na renovacao, o vendor era
        // pulado para sempre e mantinha PREMIUM (comissao 0%, 10 lojas, cupons,
        // analytics) sem pagar mais nada.
        const cicloVigente =
          activeSubscription?.currentPeriodEnd != null &&
          new Date(activeSubscription.currentPeriodEnd).getTime() > now.getTime();

        if (cicloVigente) {
          this.logger.debug(`Vendor ${vendor.id} has active subscription, skipping expiry`);
          continue;
        }

        // BUGFIX: janela de renovacao. Numa renovacao normal de cartao,
        // planExpiresAt = currentPeriodEnd = fim do ciclo; o Pagar.me so avanca
        // currentPeriodEnd quando cobra a proxima fatura e envia invoice.paid.
        // Entre o fim do ciclo e esse webhook (segundos a minutos), o vendor de
        // cartao EM DIA tinha planExpiresAt < now e currentPeriodEnd <= now →
        // era rebaixado para FREE e tinha o pagarmeSubscriptionId zerado (que o
        // invoice.paid nao restaura). Grace de 3 dias para assinaturas de cartao
        // cobre essa janela e o inicio do dunning, sem pular para sempre um
        // cartao recusado. PIX manual (sem assinatura no Pagar.me) NAO ganha
        // grace — nao renova sozinho, entao expira na hora.
        const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
        const temAssinaturaCartao = !!activeSubscription && !!vendor.pagarmeSubscriptionId;
        if (temAssinaturaCartao) {
          const expiraMs = vendor.planExpiresAt ? new Date(vendor.planExpiresAt).getTime() : 0;
          if (expiraMs > now.getTime() - GRACE_MS) {
            this.logger.debug(
              `Vendor ${vendor.id}: assinatura de cartao no grace de renovacao ` +
                `(expira ${vendor.planExpiresAt}) — aguardando invoice.paid, skip.`,
            );
            continue;
          }
          this.logger.warn(
            `Vendor ${vendor.id}: assinatura de cartao sem ciclo pago vigente e fora do grace ` +
              `(${GRACE_MS / 86400000}d) — rebaixando (provavel cartao recusado).`,
          );
        }

        // Also check cancelAtPeriodEnd subscriptions
        const pendingCancel = await this.subscriptionsRepository.findOne({
          where: {
            vendorUser: { id: vendor.id },
            cancelAtPeriodEnd: true,
            status: Not('canceled'),
          },
        });

        // Downgrade to FREE.
        // Passa pelo servico em vez de salvar a entity na mao: `updateVendorPlan`
        // dispara `onPlanChanged`, que recalcula o selo de verificacao. Salvando
        // direto no repositorio, um lojista ENTERPRISE que tinha piso GOLD
        // automatico continuava exibindo selo GOLD depois de virar FREE — e
        // mantinha as recompensas do selo, incluindo desconto permanente numa
        // reassinatura futura. O outro caminho de downgrade
        // (`handleSubscriptionCanceled`) ja usava o servico, entao o mesmo
        // evento de negocio produzia resultados diferentes conforme a rota.
        const previousPlan = vendor.vendorPlan;
        await this.vendorUsersService.updateVendorPlan(
          vendor.id,
          VendorPlan.FREE,
          0,
        );
        await this.vendorUsersRepository.update(vendor.id, {
          pagarmeSubscriptionId: null as any,
        });

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
