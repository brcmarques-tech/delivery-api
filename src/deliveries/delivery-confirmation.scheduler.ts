import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { OrdersService } from '../orders/orders.service';

@Injectable()
export class DeliveryConfirmationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryConfirmationScheduler.name);
  private intervalId: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    private ordersService: OrdersService,
  ) {}

  onModuleInit() {
    // Check every 60 seconds for expired delivery confirmations and awaiting payment orders
    this.intervalId = setInterval(() => {
      this.autoConfirmExpiredDeliveries();
      this.expireAwaitingPaymentOrders();
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

  private async autoConfirmExpiredDeliveries() {
    // Auto-confirm customer receipt after 10 minutes of delivery
    // With Pagar.me split, payments are already distributed — this just tracks confirmation
    try {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      const expiredOrders = await this.ordersRepository
        .createQueryBuilder('order')
        .leftJoinAndSelect('order.delivery', 'delivery')
        .where('delivery.deliveredAt IS NOT NULL')
        .andWhere('delivery.deliveredAt <= :tenMinAgo', { tenMinAgo })
        .andWhere('order.customerConfirmedAt IS NULL')
        .getMany();

      for (const order of expiredOrders) {
        try {
          order.customerConfirmedAt = new Date();
          await this.ordersRepository.save(order);
        } catch (err) {
          this.logger.error(`Auto-confirm failed for order ${order.id}:`, err);
        }
      }

      if (expiredOrders.length > 0) {
        this.logger.log(`Auto-confirmed ${expiredOrders.length} deliveries`);
      }
    } catch (err) {
      this.logger.error('Failed to auto-confirm deliveries:', err);
    }
  }
}
