import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderStatusLog } from './entities/order-status-log.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { OrdersService } from './orders.service';
import { OrdersResolver } from './orders.resolver';
import { ProductsModule } from '../products/products.module';
import { StoresModule } from '../stores/stores.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { PaymentsModule } from '../payments/payments.module';
import { PlatformConfigModule } from '../config/platform-config.module';
import { AddressesModule } from '../addresses/addresses.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CouponsModule } from '../coupons/coupons.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, Delivery, OrderStatusLog]),
    ProductsModule,
    forwardRef(() => StoresModule),
    forwardRef(() => DeliveriesModule),
    PaymentsModule,
    PlatformConfigModule,
    AddressesModule,
    NotificationsModule,
    CouponsModule,
    MailModule,
  ],
  providers: [OrdersService, OrdersResolver],
  exports: [OrdersService],
})
export class OrdersModule {}
