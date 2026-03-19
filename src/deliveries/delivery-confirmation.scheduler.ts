import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { OrdersService } from '../orders/orders.service';

@Injectable()
export class DeliveryConfirmationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryConfirmationScheduler.name);
  private intervalId: ReturnType<typeof setInterval>;

  constructor(
    private ordersService: OrdersService,
  ) {}

  onModuleInit() {
    // Check every 60 seconds
    this.intervalId = setInterval(() => {
      this.expireAwaitingPaymentOrders();
      this.expirePendingOrders();
      this.autoConfirmExpiredDeliveries();
      this.alertNoDeliverer();
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  // Expirar pedidos sem pagamento (AWAITING_PAYMENT > 30 min)
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

  // Expirar pedidos PENDING sem resposta do vendedor (> 10 min)
  private async expirePendingOrders() {
    try {
      const count = await this.ordersService.expirePendingOrders();
      if (count > 0) {
        this.logger.log(`Expired ${count} pending orders (vendor no response)`);
      }
    } catch (err) {
      this.logger.error('Failed to expire pending orders:', err);
    }
  }

  // Auto-confirmar entrega se cliente não responder em 10 min
  private async autoConfirmExpiredDeliveries() {
    try {
      const count = await this.ordersService.autoConfirmExpiredDeliveries();
      if (count > 0) {
        this.logger.log(`Auto-confirmed ${count} deliveries (customer no response)`);
      }
    } catch (err) {
      this.logger.error('Failed to auto-confirm deliveries:', err);
    }
  }

  // Alertar vendedor se nenhum entregador aceitar em 15 min
  private async alertNoDeliverer() {
    try {
      const count = await this.ordersService.alertNoDeliverer();
      if (count > 0) {
        this.logger.log(`Alerted ${count} orders with no deliverer`);
      }
    } catch (err) {
      this.logger.error('Failed to alert no deliverer:', err);
    }
  }
}
