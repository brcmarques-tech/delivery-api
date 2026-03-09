import { Module } from '@nestjs/common';
import { DashboardResolver } from './dashboard.resolver';
import { UsersModule } from '../users/users.module';
import { StoresModule } from '../stores/stores.module';
import { OrdersModule } from '../orders/orders.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [UsersModule, StoresModule, OrdersModule, DeliveriesModule, PaymentsModule],
  providers: [DashboardResolver],
})
export class DashboardModule {}
