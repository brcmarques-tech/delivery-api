import { Resolver, Query } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { NotificationLog } from './entities/notification-log.entity';

@Resolver()
export class NotificationLogResolver {
  constructor(
    @InjectRepository(NotificationLog)
    private logRepository: Repository<NotificationLog>,
  ) {}

  @Query(() => [NotificationLog])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async notificationLogs(): Promise<NotificationLog[]> {
    return this.logRepository.find({
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }
}
