import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderStatusLog } from './entities/order-status-log.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { OrdersService } from './orders.service';
import { OrdersResolver } from './orders.resolver';
import { DeliveryCodesService } from './delivery-codes.service';
import { ProductsModule } from '../products/products.module';
import { StoresModule } from '../stores/stores.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { PaymentsModule } from '../payments/payments.module';
import { PlatformConfigModule } from '../config/platform-config.module';
import { AddressesModule } from '../addresses/addresses.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CouponsModule } from '../coupons/coupons.module';
import { MailModule } from '../mail/mail.module';
import { FidelidadeModule } from '../loyalty/fidelidade.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, Delivery, OrderStatusLog]),
    // KAN-12: a conclusao do pedido e o momento em que o marco de fidelidade e
    // avaliado — o premio chega com a pessoa ainda com o app na mao.
    FidelidadeModule,
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
  providers: [OrdersService, OrdersResolver, DeliveryCodesService],
  // Exportado porque a camada de entregas precisa dele para gerar o código do
  // entregador no momento em que a corrida é aceita.
  exports: [OrdersService, DeliveryCodesService],
})
export class OrdersModule {}
