import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { N8nAgentController } from './n8n-agent.controller';
import { StoresModule } from '../stores/stores.module';
import { OrdersModule } from '../orders/orders.module';
import { ProductsModule } from '../products/products.module';
import { CouponsModule } from '../coupons/coupons.module';
import { AppUser } from '../users/entities/app-user.entity';
import { Store } from '../stores/entities/store.entity';

@Module({
  imports: [
    ConfigModule,
    StoresModule,
    OrdersModule,
    ProductsModule,
    CouponsModule,
    TypeOrmModule.forFeature([AppUser, Store]),
  ],
  controllers: [N8nAgentController],
})
export class N8nAgentModule {}
