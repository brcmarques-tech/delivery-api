import { Module } from '@nestjs/common';
import { DashboardResolver } from './dashboard.resolver';
import { UsersModule } from '../users/users.module';
import { StoresModule } from '../stores/stores.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [UsersModule, StoresModule, OrdersModule],
  providers: [DashboardResolver],
})
export class DashboardModule {}
