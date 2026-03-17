import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity';
import { Store } from '../stores/entities/store.entity';
import { PaymentsService } from './payments.service';
import { PaymentsResolver } from './payments.resolver';
import { PaymentsController } from './payments.controller';
import { UsersModule } from '../users/users.module';
import { PlatformConfigModule } from '../config/platform-config.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, Store]),
    forwardRef(() => UsersModule),
    PlatformConfigModule,
    NotificationsModule,
  ],
  providers: [PaymentsService, PaymentsResolver],
  controllers: [PaymentsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
