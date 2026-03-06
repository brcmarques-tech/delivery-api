import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delivery } from './entities/delivery.entity';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesResolver } from './deliveries.resolver';
import { DeliveriesGateway } from './deliveries.gateway';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [TypeOrmModule.forFeature([Delivery]), OrdersModule],
  providers: [DeliveriesService, DeliveriesResolver, DeliveriesGateway],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
