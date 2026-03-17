import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { DeliveriesService } from './deliveries.service';
import { OrdersService } from '../orders/orders.service';

@Injectable()
export class DeliveryConfirmationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryConfirmationScheduler.name);
  private intervalId: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    private deliveriesService: DeliveriesService,
    @Inject(forwardRef(() => OrdersService))
    private ordersService: OrdersService,
    private configService: ConfigService,
  ) {}

  onModuleInit() {
    // Check every 60 seconds for expired delivery confirmations and awaiting payment orders
    this.intervalId = setInterval(() => {
      this.autoConfirmExpiredDeliveries();
      this.expireAwaitingPaymentOrders();
      this.retryPendingPayouts();
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private async expireAwaitingPaymentOrders() {
    try {
      const count = await this.ordersService.expireAwaitingPaymentOrders();
      if (count > 0) {
        this.logger.log(`Expired ${count} awaiting payment orders`);
      }
    } catch (err) {
      this.logger.error('Failed to expire awaiting payment orders:', err);
    }
  }

  private async retryPendingPayouts() {
    // Skip if MP_PAYER_EMAIL is not configured — transfers will always fail
    if (!this.configService.get('MP_PAYER_EMAIL')) return;

    try {
      const pending = await this.deliveriesService.findPendingPayouts();
      for (const delivery of pending) {
        if (delivery.payoutStatus === 'failed') {
          await this.deliveriesService.processDelivererPayout(delivery.id);
          this.logger.log(`Retry payout entregador delivery ${delivery.id}`);
        }
      }
    } catch (err) {
      this.logger.error('Failed to process payouts:', err);
    }
  }

  private async autoConfirmExpiredDeliveries() {
    const expiredDeliveries =
      await this.deliveriesService.findExpiredPendingConfirmations();

    for (const delivery of expiredDeliveries) {
      try {
        const order = delivery.order;
        order.customerConfirmedAt = new Date();
        await this.ordersRepository.save(order);

        await this.deliveriesService.processDelivererPayout(delivery.id);
      } catch (err) {
        console.error(
          `Auto-confirm failed for delivery ${delivery.id}:`,
          err,
        );
      }
    }
  }
}
