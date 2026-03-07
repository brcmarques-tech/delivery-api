import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailService } from './mail.service';
import { NotificationLog } from './entities/notification-log.entity';
import { NotificationLogResolver } from './notification-log.resolver';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([NotificationLog])],
  providers: [MailService, NotificationLogResolver],
  exports: [MailService],
})
export class MailModule {}
