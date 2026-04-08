import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import {
  AgentSession,
  AgentSessionStatus,
} from './entities/agent-session.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { UserRole } from '../common/enums';

export const AGENT_QUEUE = 'whatsapp-agent';

export interface WahaMessagePayload {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
  type: string;
}

@Injectable()
export class WhatsAppAgentService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsAppAgentService.name);

  constructor(
    @InjectQueue(AGENT_QUEUE) private readonly agentQueue: Queue,
    @InjectRepository(AgentSession)
    private readonly sessionsRepository: Repository<AgentSession>,
    @InjectRepository(AppUser)
    private readonly appUsersRepository: Repository<AppUser>,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    await this.ensureAgentUser();
  }

  private async ensureAgentUser() {
    const email =
      this.configService.get('AGENT_APP_USER_EMAIL') || 'agente@bcmtech.com.br';
    const existing = await this.appUsersRepository.findOne({
      where: { email },
    });
    if (!existing) {
      const hash = await bcrypt.hash('agent-internal-password-2026', 10);
      const agent = this.appUsersRepository.create({
        name: 'Agente WhatsApp',
        email,
        phone: '00000000000',
        password: hash,
        role: UserRole.CUSTOMER,
        isActive: true,
      });
      await this.appUsersRepository.save(agent);
      this.logger.log('Conta do agente WhatsApp criada');
    }
  }

  async enqueueMessage(payload: WahaMessagePayload): Promise<void> {
    await this.agentQueue.add('process-message', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  }

  async getOrCreateSession(
    phoneNumber: string,
    storeId: string,
  ): Promise<AgentSession> {
    let session = await this.sessionsRepository.findOne({
      where: { phoneNumber },
    });
    if (!session) {
      session = this.sessionsRepository.create({
        phoneNumber,
        storeId,
        conversationHistory: [],
        status: AgentSessionStatus.ACTIVE,
      });
    }
    session.storeId = storeId;
    session.lastMessageAt = new Date();
    return this.sessionsRepository.save(session);
  }

  async updateSession(session: AgentSession): Promise<AgentSession> {
    return this.sessionsRepository.save(session);
  }

  async findSessionByPhone(phoneNumber: string): Promise<AgentSession | null> {
    return this.sessionsRepository.findOne({ where: { phoneNumber } });
  }
}
