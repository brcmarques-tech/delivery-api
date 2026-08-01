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
import { GeolocationAutomationService } from './geolocation-automation.service';
import { OrdersModule } from '../orders/orders.module';
import { UsersModule } from '../users/users.module';
// PaymentsModule no longer needed — Pagar.me split handles all payments at transaction time
import { NotificationsModule } from '../notifications/notifications.module';
import { PlatformConfigModule } from '../config/platform-config.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Delivery, Order]),
    forwardRef(() => OrdersModule),
    forwardRef(() => UsersModule),
    NotificationsModule,
    PlatformConfigModule,
  ],
  providers: [
    DeliveriesService,
    DeliveriesResolver,
    DeliveriesGateway,
    DelivererTrackerService,
    DeliveryOfferService,
    DeliveryConfirmationScheduler,
    GeolocationAutomationService,
  ],
  exports: [DeliveriesService, DeliveryOfferService, DelivererTrackerService],
})
export class DeliveriesModule {}
