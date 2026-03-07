import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';
import { PaymentsResolver } from './payments.resolver';
import { PaymentsController } from './payments.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([Payment]), UsersModule],
  providers: [PaymentsService, PaymentsResolver],
  controllers: [PaymentsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
