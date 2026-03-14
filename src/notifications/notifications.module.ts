import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [TypeOrmModule.forFeature([AppUser, VendorUser])],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
