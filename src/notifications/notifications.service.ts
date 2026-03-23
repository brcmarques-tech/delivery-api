import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(AppUser)
    private appUsersRepository: Repository<AppUser>,
    @InjectRepository(VendorUser)
    private vendorUsersRepository: Repository<VendorUser>,
  ) {}

  async sendToAppUser(userId: string, title: string, body: string, data?: Record<string, any>): Promise<void> {
    const user = await this.appUsersRepository.findOne({ where: { id: userId } });
    if (!user?.expoPushToken) return;

    await this.sendPushNotifications([{
      to: user.expoPushToken,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
      channelId: 'default',
    }]);
  }

  async sendToVendorUser(userId: string, title: string, body: string, data?: Record<string, any>): Promise<void> {
    const user = await this.vendorUsersRepository.findOne({ where: { id: userId } });
    if (!user?.expoPushToken) return;

    await this.sendPushNotifications([{
      to: user.expoPushToken,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
      channelId: 'default',
    }]);
  }

  async sendToUser(userId: string, title: string, body: string, data?: Record<string, any>): Promise<void> {
    this.logger.log(`[sendToUser] userId=${userId} title="${title}"`);
    // Try app user first, then vendor
    const appUser = await this.appUsersRepository.findOne({ where: { id: userId } });
    if (appUser?.expoPushToken) {
      this.logger.log(`[sendToUser] Found AppUser ${appUser.name} with token ${appUser.expoPushToken.substring(0, 30)}...`);
      await this.sendPushNotifications([{ to: appUser.expoPushToken, title, body, data, sound: 'default', priority: 'high', channelId: 'default' }]);
      return;
    }
    this.logger.log(`[sendToUser] AppUser ${userId} has no token, trying VendorUser...`);
    const vendorUser = await this.vendorUsersRepository.findOne({ where: { id: userId } });
    if (vendorUser?.expoPushToken) {
      this.logger.log(`[sendToUser] Found VendorUser ${vendorUser.name} with token ${vendorUser.expoPushToken.substring(0, 30)}...`);
      await this.sendPushNotifications([{ to: vendorUser.expoPushToken, title, body, data, sound: 'default', priority: 'high', channelId: 'default' }]);
    } else {
      this.logger.warn(`[sendToUser] NO TOKEN FOUND for userId=${userId} (appUser: ${appUser?.name || 'NULL'}, vendorUser: ${vendorUser?.name || 'NULL'})`);
    }
  }

  async sendToUsers(userIds: string[], title: string, body: string, data?: Record<string, any>): Promise<void> {
    const appUsers = await this.appUsersRepository.find({
      where: { id: In(userIds) },
    });
    const vendorUsers = await this.vendorUsersRepository.find({
      where: { id: In(userIds) },
    });

    const messages: ExpoPushMessage[] = [...appUsers, ...vendorUsers]
      .filter((u) => u.expoPushToken)
      .map((u) => ({
        to: u.expoPushToken,
        title,
        body,
        data,
        sound: 'default' as const,
        priority: 'high' as const,
        channelId: 'default',
      }));

    if (messages.length > 0) {
      await this.sendPushNotifications(messages);
    }
  }

  async sendToStoreOwner(storeOwnerId: string, title: string, body: string, data?: Record<string, any>): Promise<void> {
    await this.sendToVendorUser(storeOwnerId, title, body, data);
  }

  private async sendPushNotifications(messages: ExpoPushMessage[]): Promise<void> {
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      const result = await response.json();
      if (result.errors) {
        this.logger.error('[sendPush] Expo push errors:', JSON.stringify(result.errors));
      }
      if (result.data) {
        result.data.forEach((ticket: any, i: number) => {
          if (ticket.status === 'error') {
            this.logger.error(`[sendPush] FAILED for ${messages[i].to}: ${ticket.message}`);
          }
        });
      }
    } catch (error) {
      this.logger.error('[sendPush] Failed to send push notifications', error);
    }
  }
}
