import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { N8nAgentController } from './n8n-agent.controller';
import { StoresModule } from '../stores/stores.module';
import { OrdersModule } from '../orders/orders.module';
import { AppUser } from '../users/entities/app-user.entity';

@Module({
  imports: [
    ConfigModule,
    StoresModule,
    OrdersModule,
    TypeOrmModule.forFeature([AppUser]),
  ],
  controllers: [N8nAgentController],
})
export class N8nAgentModule {}
