import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { fetchWithTimeout } from '../common/utils/fetch-with-timeout'; // KAN-253

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
    // A API do Expo limita 100 mensagens por request e REJEITA o payload inteiro
    // se passar disso. Antes, um broadcast para >100 destinatários (ex.: todos os
    // entregadores offline via notifyAllDeliverers) era rejeitado e NINGUÉM
    // recebia. Agora envia em lotes de 100.
    const CHUNK = 100;
    for (let i = 0; i < messages.length; i += CHUNK) {
      const batch = messages.slice(i, i + CHUNK);
      try {
        const response = await fetchWithTimeout('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(batch),
        });

        const result = await response.json();
        if (result.errors) {
          this.logger.error('[sendPush] Expo push errors:', JSON.stringify(result.errors));
        }
        if (result.data) {
          const deadTokens: string[] = [];
          result.data.forEach((ticket: any, j: number) => {
            if (ticket.status === 'error') {
              this.logger.error(`[sendPush] FAILED for ${batch[j].to}: ${ticket.message}`);
              // DeviceNotRegistered = app desinstalado / token expirado. Marca
              // para limpeza (senão o token morto fica sendo re-tentado pra sempre).
              if (ticket.details?.error === 'DeviceNotRegistered') {
                deadTokens.push(batch[j].to);
              }
            }
          });
          if (deadTokens.length) await this.pruneDeadTokens(deadTokens);
        }
      } catch (error) {
        this.logger.error('[sendPush] Failed to send push notifications', error);
      }
    }
  }

  /** Remove tokens de push que o Expo reportou como não registrados. */
  private async pruneDeadTokens(tokens: string[]): Promise<void> {
    try {
      const nulled = { expoPushToken: null as any };
      await this.appUsersRepository.update({ expoPushToken: In(tokens) }, nulled);
      await this.vendorUsersRepository.update({ expoPushToken: In(tokens) }, nulled);
      this.logger.log(`[sendPush] ${tokens.length} token(s) morto(s) removido(s)`);
    } catch (e: any) {
      this.logger.error('[sendPush] Falha ao limpar tokens mortos', e?.message);
    }
  }
}
