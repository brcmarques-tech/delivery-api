import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delivery } from './entities/delivery.entity';
import { Order } from '../orders/entities/order.entity';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesResolver } from './deliveries.resolver';
import { DeliveriesGateway } from './deliveries.gateway';
import { DelivererTrackerService } from './deliverer-tracker.service';
import { DeliveryOfferService } from './delivery-offer.service';
import { DeliveryConfirmationScheduler } from './delivery-confirmation.scheduler';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Delivery, Order]),
    forwardRef(() => OrdersModule),
    PaymentsModule,
    UsersModule,
  ],
  providers: [
    DeliveriesService,
    DeliveriesResolver,
    DeliveriesGateway,
    DelivererTrackerService,
    DeliveryOfferService,
    DeliveryConfirmationScheduler,
  ],
  exports: [DeliveriesService, DeliveryOfferService, DelivererTrackerService],
})
export class DeliveriesModule {}
