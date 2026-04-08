import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WhatsAppAgentController } from './whatsapp-agent.controller';
import { WhatsAppAgentService, AGENT_QUEUE } from './whatsapp-agent.service';
import { WhatsAppAgentProcessor } from './whatsapp-agent.processor';
import { AgentSession } from './entities/agent-session.entity';
import { StoresModule } from '../stores/stores.module';
import { OrdersModule } from '../orders/orders.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AppUser } from '../users/entities/app-user.entity';

@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        redis: {
          host: config.get('REDIS_HOST', 'redis'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: AGENT_QUEUE }),
    TypeOrmModule.forFeature([AgentSession, AppUser]),
    StoresModule,
    OrdersModule,
    WhatsAppModule,
  ],
  controllers: [WhatsAppAgentController],
  providers: [WhatsAppAgentService, WhatsAppAgentProcessor],
})
export class WhatsAppAgentModule {}
