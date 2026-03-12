import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { NotificationLog } from './entities/notification-log.entity';

@Injectable()
export class MailService {
  private resend: Resend | null;
  private readonly logger = new Logger(MailService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(NotificationLog)
    private logRepository: Repository<NotificationLog>,
  ) {
    const apiKey = this.configService.get('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY não configurada - emails desabilitados');
    }
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  private get from(): string {
    return this.configService.get('MAIL_FROM', 'BCM TECH DELIVERY AG <onboarding@resend.dev>');
  }

  private async saveLog(data: Partial<NotificationLog>): Promise<void> {
    try {
      await this.logRepository.save(this.logRepository.create(data));
    } catch (e) {
      this.logger.error('Erro ao salvar log de notificacao', e);
    }
  }

  private async sendEmail(to: string, subject: string, html: string): Promise<void> {
    if (!this.resend) throw new Error('Email desabilitado: RESEND_API_KEY não configurada');
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html,
    });
    if (error) throw new Error(error.message);
  }

  async sendApprovalEmail(to: string, name: string, role: string): Promise<void> {
    const roleLabel = role === 'DELIVERER' ? 'Entregador' : 'Vendedor';
    const subject = 'bcmTech - Cadastro aprovado!';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #FF6B35; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">bcmTech Delivery</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #2D3436;">Parabens, ${name}!</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Seu cadastro como <strong>${roleLabel}</strong> foi <span style="color: #27AE60; font-weight: bold;">aprovado</span> na plataforma bcmTech Delivery.
          </p>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            ${role === 'DELIVERER'
              ? 'Voce ja pode acessar a aba de Entregas no aplicativo e comecar a fazer entregas!'
              : 'Voce ja pode acessar o Painel do Vendedor e cadastrar sua loja e produtos!'}
          </p>
          <div style="text-align: center; margin-top: 30px;">
            <div style="display: inline-block; background: #27AE60; color: white; padding: 12px 30px; border-radius: 8px; font-size: 16px; font-weight: bold;">
              Aprovado &#10003;
            </div>
          </div>
          <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
            Este email foi enviado automaticamente pela plataforma bcmTech Delivery.
          </p>
        </div>
      </div>
    `;
    try {
      await this.sendEmail(to, subject, html);
      this.logger.log(`Email de aprovacao enviado para ${to}`);
      await this.saveLog({ type: 'EMAIL', to, userName: name, subject, message: `Cadastro como ${roleLabel} aprovado`, success: true, error: null });
    } catch (error) {
      this.logger.error(`Erro ao enviar email de aprovacao para ${to}`, error);
      await this.saveLog({ type: 'EMAIL', to, userName: name, subject, message: `Cadastro como ${roleLabel} aprovado`, success: false, error: String(error) });
    }
  }

  async sendRejectionEmail(to: string, name: string, role: string, reason: string): Promise<void> {
    const roleLabel = role === 'DELIVERER' ? 'Entregador' : 'Vendedor';
    const subject = 'bcmTech - Cadastro nao aprovado';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #FF6B35; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">bcmTech Delivery</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #2D3436;">Ola, ${name}</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Infelizmente seu cadastro como <strong>${roleLabel}</strong> nao foi aprovado na plataforma bcmTech Delivery.
          </p>
          <div style="background: #fff3f3; border-left: 4px solid #E74C3C; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
            <p style="color: #E74C3C; font-weight: bold; margin: 0 0 5px 0;">Motivo:</p>
            <p style="color: #555; margin: 0;">${reason}</p>
          </div>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Voce ainda pode usar a plataforma como cliente normalmente. Se acredita que houve um engano, entre em contato com nosso suporte.
          </p>
          <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
            Este email foi enviado automaticamente pela plataforma bcmTech Delivery.
          </p>
        </div>
      </div>
    `;
    try {
      await this.sendEmail(to, subject, html);
      this.logger.log(`Email de rejeicao enviado para ${to}`);
      await this.saveLog({ type: 'EMAIL', to, userName: name, subject, message: `Cadastro como ${roleLabel} rejeitado. Motivo: ${reason}`, success: true, error: null });
    } catch (error) {
      this.logger.error(`Erro ao enviar email de rejeicao para ${to}`, error);
      await this.saveLog({ type: 'EMAIL', to, userName: name, subject, message: `Cadastro como ${roleLabel} rejeitado. Motivo: ${reason}`, success: false, error: String(error) });
    }
  }

  async resendEmail(log: NotificationLog): Promise<boolean> {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #FF6B35; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">bcmTech Delivery</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #2D3436;">Ola, ${log.userName}!</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">${log.message}</p>
          <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
            Este email foi enviado automaticamente pela plataforma bcmTech Delivery.
          </p>
        </div>
      </div>
    `;
    try {
      await this.sendEmail(log.to, log.subject, html);
      this.logger.log(`Email reenviado para ${log.to}`);
      log.success = true;
      log.error = null;
      log.retryCount = (log.retryCount || 0) + 1;
      await this.logRepository.save(log);
      return true;
    } catch (error) {
      this.logger.error(`Erro ao reenviar email para ${log.to}`, error);
      log.retryCount = (log.retryCount || 0) + 1;
      log.error = String(error);
      await this.logRepository.save(log);
      return false;
    }
  }

  async retryFailedEmails(): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const failedLogs = await this.logRepository.find({
      where: { success: false },
    });

    for (const log of failedLogs) {
      if (log.retryCount >= 1) continue;
      if (log.createdAt > oneHourAgo) continue;

      this.logger.log(`Auto-retry email para ${log.to}`);
      await this.resendEmail(log);
    }
  }
}
