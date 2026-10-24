import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceiroResolver } from './financeiro.resolver';
import { Order } from '../orders/entities/order.entity';
import { DashboardResolver } from './dashboard.resolver';
import { UsersModule } from '../users/users.module';
import { StoresModule } from '../stores/stores.module';
import { OrdersModule } from '../orders/orders.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { PaymentsModule } from '../payments/payments.module';
import { AppointmentsModule } from '../appointments/appointments.module';

@Module({
  imports: [TypeOrmModule.forFeature([Order]), UsersModule, StoresModule, OrdersModule, DeliveriesModule, PaymentsModule, AppointmentsModule],
  providers: [DashboardResolver, FinanceiroResolver],
})
export class DashboardModule {}
