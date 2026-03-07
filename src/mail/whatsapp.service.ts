import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { NotificationLog } from './entities/notification-log.entity';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private apiUrl: string;
  private apiKey: string;
  private instance: string;
  private ready = false;

  constructor(
    private configService: ConfigService,
    @InjectRepository(NotificationLog)
    private logRepository: Repository<NotificationLog>,
  ) {
    this.apiUrl = this.configService.get('EVOLUTION_API_URL', 'http://localhost:8080');
    this.apiKey = this.configService.get('EVOLUTION_API_KEY', '');
    this.instance = this.configService.get('EVOLUTION_INSTANCE', 'bcmtech');
  }

  async onModuleInit() {
    try {
      await this.createInstance();
    } catch (error) {
      this.logger.warn('Evolution API nao disponivel. WhatsApp desabilitado.');
    }
  }

  private async request(path: string, method = 'GET', body?: any): Promise<any> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  private async createInstance(): Promise<void> {
    const result = await this.request('/instance/create', 'POST', {
      instanceName: this.instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    });
    this.logger.log(`Instancia "${this.instance}" criada/conectada`);
    this.ready = true;

    if (result?.qrcode?.base64) {
      this.logger.warn('QR Code disponivel! Acesse http://localhost:8080/manager para escanear.');
    }
  }

  async getQrCode(): Promise<string | null> {
    try {
      const result = await this.request(`/instance/connect/${this.instance}`);
      return result?.base64 || null;
    } catch {
      return null;
    }
  }

  async getStatus(): Promise<string> {
    try {
      const result = await this.request(`/instance/connectionState/${this.instance}`);
      return result?.instance?.state || 'disconnected';
    } catch {
      return 'unavailable';
    }
  }

  async sendText(phone: string, message: string): Promise<boolean> {
    if (!this.ready) {
      this.logger.warn('WhatsApp nao esta pronto. Mensagem nao enviada.');
      return false;
    }

    // Formata o numero: remove tudo que nao e digito, adiciona 55 se nao tiver
    let number = phone.replace(/\D/g, '');
    if (!number.startsWith('55')) {
      number = '55' + number;
    }

    try {
      await this.request(`/message/sendText/${this.instance}`, 'POST', {
        number,
        text: message,
      });
      this.logger.log(`WhatsApp enviado para ${number}`);
      return true;
    } catch (error) {
      this.logger.error(`Erro ao enviar WhatsApp para ${number}`, error);
      return false;
    }
  }

  private async saveLog(data: Partial<NotificationLog>): Promise<void> {
    try {
      await this.logRepository.save(this.logRepository.create(data));
    } catch (e) {
      this.logger.error('Erro ao salvar log de notificacao', e);
    }
  }

  async sendApproval(phone: string, name: string, role: string): Promise<void> {
    const roleLabel = role === 'DELIVERER' ? 'Entregador' : 'Vendedor';
    const msg = `Cadastro como ${roleLabel} aprovado`;
    const sent = await this.sendText(
      phone,
      `*bcmTech Delivery*\n\n` +
      `Ola ${name}! 🎉\n\n` +
      `Seu cadastro como *${roleLabel}* foi *aprovado*!\n\n` +
      `${role === 'DELIVERER'
        ? 'Voce ja pode acessar a aba de Entregas no app e comecar a fazer entregas.'
        : 'Voce ja pode acessar o Painel do Vendedor e cadastrar sua loja e produtos.'}\n\n` +
      `Obrigado por fazer parte da bcmTech! 🚀`,
    );
    await this.saveLog({ type: 'WHATSAPP', to: phone, userName: name, subject: 'Cadastro aprovado', message: msg, success: sent, error: sent ? null : 'WhatsApp nao enviado' });
  }

  async sendRejection(phone: string, name: string, role: string, reason: string): Promise<void> {
    const roleLabel = role === 'DELIVERER' ? 'Entregador' : 'Vendedor';
    const msg = `Cadastro como ${roleLabel} rejeitado. Motivo: ${reason}`;
    const sent = await this.sendText(
      phone,
      `*bcmTech Delivery*\n\n` +
      `Ola ${name},\n\n` +
      `Infelizmente seu cadastro como *${roleLabel}* nao foi aprovado.\n\n` +
      `*Motivo:* ${reason}\n\n` +
      `Voce ainda pode usar a plataforma como cliente normalmente. ` +
      `Se acredita que houve um engano, entre em contato com nosso suporte.`,
    );
    await this.saveLog({ type: 'WHATSAPP', to: phone, userName: name, subject: 'Cadastro rejeitado', message: msg, success: sent, error: sent ? null : 'WhatsApp nao enviado' });
  }

  async sendOrderUpdate(phone: string, orderNumber: string, status: string): Promise<void> {
    const statusLabels: Record<string, string> = {
      CONFIRMED: 'foi confirmado pelo estabelecimento ✅',
      PREPARING: 'esta sendo preparado 👨‍🍳',
      READY: 'esta pronto para entrega 📦',
      OUT_FOR_DELIVERY: 'saiu para entrega 🛵',
      DELIVERED: 'foi entregue! 🎉',
      CANCELLED: 'foi cancelado ❌',
    };

    const statusMsg = statusLabels[status];
    if (!statusMsg) return;

    await this.sendText(
      phone,
      `*bcmTech Delivery*\n\n` +
      `Seu pedido *#${orderNumber}* ${statusMsg}`,
    );
  }
}
