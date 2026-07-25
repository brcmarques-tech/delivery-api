import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { Payment } from './entities/payment.entity';
import { SavedCard } from './entities/saved-card.entity';
import { WebhookEvent } from './entities/webhook-event.entity';
import { Subscription } from './entities/subscription.entity';
import { PagarmePlan } from './entities/pagarme-plan.entity';
import { Store } from '../stores/entities/store.entity';
import { Appointment } from '../appointments/entities/appointment.entity';
import { PaymentsService } from './payments.service';
import { PaymentsResolver } from './payments.resolver';
import { PaymentsController } from './payments.controller';
import { SubscriptionPlansService } from './subscription-plans.service';
import { SubscriptionExpiryScheduler } from './subscription-expiry.scheduler';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { UsersModule } from '../users/users.module';
import { PlatformConfigModule } from '../config/platform-config.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, SavedCard, Store, WebhookEvent, Appointment, Subscription, PagarmePlan, VendorUser]),
    // Error#1: sem timeout, axios usa `timeout: 0` (infinito). Uma chamada ao
    // Pagar.me (captura/transferência/estorno num checkout ou no webhook) que
    // travasse pinava a request pra sempre e esgotava o pool → cascata. 15s é
    // folgado para o Pagar.me e ainda evita o hang.
    HttpModule.register({ timeout: 15000 }),
    forwardRef(() => UsersModule),
    PlatformConfigModule,
    NotificationsModule,
  ],
  providers: [PaymentsService, PaymentsResolver, SubscriptionPlansService, SubscriptionExpiryScheduler],
  controllers: [PaymentsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
