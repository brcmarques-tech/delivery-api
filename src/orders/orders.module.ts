import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { OrdersService } from './orders.service';
import { OrdersResolver } from './orders.resolver';
import { ProductsModule } from '../products/products.module';
import { StoresModule } from '../stores/stores.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { PaymentsModule } from '../payments/payments.module';
import { PlatformConfigModule } from '../config/platform-config.module';
import { AddressesModule } from '../addresses/addresses.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, Delivery]),
    ProductsModule,
    forwardRef(() => StoresModule),
    forwardRef(() => DeliveriesModule),
    PaymentsModule,
    PlatformConfigModule,
    AddressesModule,
  ],
  providers: [OrdersService, OrdersResolver],
  exports: [OrdersService],
})
export class OrdersModule {}
