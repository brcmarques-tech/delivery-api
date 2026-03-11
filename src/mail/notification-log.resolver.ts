import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { NotificationLog } from './entities/notification-log.entity';
import { MailService } from './mail.service';

@Resolver()
export class NotificationLogResolver {
  constructor(
    @InjectRepository(NotificationLog)
    private logRepository: Repository<NotificationLog>,
    private mailService: MailService,
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

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async resendNotification(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    const log = await this.logRepository.findOne({ where: { id } });
    if (!log) return false;

    return this.mailService.resendEmail(log);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async deleteNotification(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    const result = await this.logRepository.delete(id);
    return (result.affected ?? 0) > 0;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async clearAllNotifications(): Promise<boolean> {
    await this.logRepository.clear();
    return true;
  }
}
