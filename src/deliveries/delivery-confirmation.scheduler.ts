import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { DeliveriesService } from './deliveries.service';

@Injectable()
export class DeliveryConfirmationScheduler implements OnModuleInit, OnModuleDestroy {
  private intervalId: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    private deliveriesService: DeliveriesService,
  ) {}

  onModuleInit() {
    // Check every 60 seconds for expired delivery confirmations
    this.intervalId = setInterval(() => this.autoConfirmExpiredDeliveries(), 60_000);
  }

  onModuleDestroy() {
    if (this.intervalId) clearInterval(this.intervalId);
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
