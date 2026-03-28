import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appointment } from './entities/appointment.entity';
import { AppointmentsService } from './appointments.service';
import { AppointmentsResolver } from './appointments.resolver';
import { AppointmentReminderScheduler } from './appointment-reminder.scheduler';
import { Store } from '../stores/entities/store.entity';
import { Service } from '../services/entities/service.entity';
import { Schedule } from '../schedules/entities/schedule.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { PlatformConfigModule } from '../config/platform-config.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Appointment, Store, Service, Schedule, AppUser]),
    NotificationsModule,
    forwardRef(() => PaymentsModule),
    PlatformConfigModule,
  ],
  providers: [AppointmentsService, AppointmentsResolver, AppointmentReminderScheduler],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
