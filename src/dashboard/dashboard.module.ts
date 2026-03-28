import { Module } from '@nestjs/common';
import { DashboardResolver } from './dashboard.resolver';
import { UsersModule } from '../users/users.module';
import { StoresModule } from '../stores/stores.module';
import { OrdersModule } from '../orders/orders.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { PaymentsModule } from '../payments/payments.module';
import { AppointmentsModule } from '../appointments/appointments.module';

@Module({
  imports: [UsersModule, StoresModule, OrdersModule, DeliveriesModule, PaymentsModule, AppointmentsModule],
  providers: [DashboardResolver],
})
export class DashboardModule {}
