import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { NotificationLog } from './entities/notification-log.entity';
import { PlatformConfigService } from '../config/platform-config.service';

@Injectable()
export class MailService {
  private resend: Resend | null;
  private readonly logger = new Logger(MailService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(NotificationLog)
    private logRepository: Repository<NotificationLog>,
    private platformConfigService: PlatformConfigService,
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
          <div style="border-top: 1px solid #eee; margin-top: 30px; padding-top: 15px; text-align: center;">
            <p style="color: #999; font-size: 11px; margin: 0;">
              Este email foi enviado automaticamente. Por favor, nao responda este email.
            </p>
            <p style="color: #999; font-size: 11px; margin: 5px 0 0 0;">
              Em caso de duvidas, entre em contato pelo <a href="mailto:suporte@bcmtech.com.br" style="color: #FF6B35;">suporte@bcmtech.com.br</a>
            </p>
          </div>
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
          <div style="border-top: 1px solid #eee; margin-top: 30px; padding-top: 15px; text-align: center;">
            <p style="color: #999; font-size: 11px; margin: 0;">
              Este email foi enviado automaticamente. Por favor, nao responda este email.
            </p>
            <p style="color: #999; font-size: 11px; margin: 5px 0 0 0;">
              Em caso de duvidas, entre em contato pelo <a href="mailto:suporte@bcmtech.com.br" style="color: #FF6B35;">suporte@bcmtech.com.br</a>
            </p>
          </div>
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

  async sendPasswordResetEmail(to: string, name: string, token: string, resetUrl: string): Promise<void> {
    const subject = 'bcmTech - Recuperacao de senha';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #FF6B35; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">bcmTech Delivery</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #2D3436;">Ola, ${name}</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Recebemos uma solicitacao para alterar sua senha. Clique no botao abaixo para criar uma nova senha. Este link expira em 1 hora.
          </p>
          <div style="text-align: center; margin-top: 30px;">
            <a href="${resetUrl}" style="display: inline-block; background: #FF6B35; color: white; padding: 12px 30px; border-radius: 8px; font-size: 16px; font-weight: bold; text-decoration: none;">
              Redefinir Senha
            </a>
          </div>
          <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
            Se voce nao solicitou esta alteracao, ignore este email.
          </p>
          <div style="border-top: 1px solid #eee; margin-top: 15px; padding-top: 15px; text-align: center;">
            <p style="color: #999; font-size: 11px; margin: 0;">
              Este email foi enviado automaticamente. Por favor, nao responda este email.
            </p>
            <p style="color: #999; font-size: 11px; margin: 5px 0 0 0;">
              Em caso de duvidas, entre em contato pelo <a href="mailto:suporte@bcmtech.com.br" style="color: #FF6B35;">suporte@bcmtech.com.br</a>
            </p>
          </div>
        </div>
      </div>
    `;
    try {
      await this.sendEmail(to, subject, html);
      this.logger.log(`Email de recuperacao de senha enviado para ${to}`);
      await this.saveLog({ type: 'EMAIL', to, userName: name, subject, message: 'Recuperacao de senha solicitada', success: true, error: null });
    } catch (error) {
      this.logger.error(`Erro ao enviar email de recuperacao de senha para ${to}`, error);
      await this.saveLog({ type: 'EMAIL', to, userName: name, subject, message: 'Recuperacao de senha solicitada', success: false, error: String(error) });
    }
  }

  async sendStoreDeleteConfirmation(to: string, adminName: string, storeName: string, confirmUrl: string): Promise<void> {
    const subject = 'bcmTech - Confirmar exclusao de loja';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #FF6B35; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">bcmTech Delivery</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #2D3436;">Confirmar exclusao</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Ola <strong>${adminName}</strong>, voce solicitou a exclusao da loja <strong>"${storeName}"</strong>.
          </p>
          <div style="background: #fff3f3; border-left: 4px solid #E74C3C; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
            <p style="color: #E74C3C; font-weight: bold; margin: 0;">Atencao: esta acao e irreversivel!</p>
            <p style="color: #555; margin: 5px 0 0 0;">Todos os produtos, categorias e dados da loja serao removidos permanentemente.</p>
          </div>
          <div style="text-align: center; margin-top: 30px;">
            <a href="${confirmUrl}" style="display: inline-block; background: #E74C3C; color: white; padding: 14px 40px; border-radius: 8px; font-size: 16px; font-weight: bold; text-decoration: none;">
              Confirmar Exclusao
            </a>
          </div>
          <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
            Este link expira em 30 minutos. Se voce nao solicitou esta acao, ignore este email.
          </p>
          <div style="border-top: 1px solid #eee; margin-top: 15px; padding-top: 15px; text-align: center;">
            <p style="color: #999; font-size: 11px; margin: 0;">
              Este email foi enviado automaticamente. Por favor, nao responda este email.
            </p>
            <p style="color: #999; font-size: 11px; margin: 5px 0 0 0;">
              Em caso de duvidas, entre em contato pelo <a href="mailto:suporte@bcmtech.com.br" style="color: #FF6B35;">suporte@bcmtech.com.br</a>
            </p>
          </div>
        </div>
      </div>
    `;
    try {
      await this.sendEmail(to, subject, html);
      this.logger.log(`Email de confirmacao de exclusao de loja enviado para ${to}`);
      await this.saveLog({ type: 'EMAIL', to, userName: adminName, subject, message: `Confirmacao de exclusao da loja "${storeName}"`, success: true, error: null });
    } catch (error) {
      this.logger.error(`Erro ao enviar email de exclusao para ${to}`, error);
      await this.saveLog({ type: 'EMAIL', to, userName: adminName, subject, message: `Confirmacao de exclusao da loja "${storeName}"`, success: false, error: String(error) });
      throw error;
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
          <div style="border-top: 1px solid #eee; margin-top: 30px; padding-top: 15px; text-align: center;">
            <p style="color: #999; font-size: 11px; margin: 0;">
              Este email foi enviado automaticamente. Por favor, nao responda este email.
            </p>
            <p style="color: #999; font-size: 11px; margin: 5px 0 0 0;">
              Em caso de duvidas, entre em contato pelo <a href="mailto:suporte@bcmtech.com.br" style="color: #FF6B35;">suporte@bcmtech.com.br</a>
            </p>
          </div>
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

  async getVendorEmailCount(vendorId: string): Promise<number> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    return this.logRepository.count({
      where: {
        vendorId,
        success: true,
        createdAt: MoreThanOrEqual(startOfMonth),
      },
    });
  }

  async checkVendorEmailLimit(vendorId: string, vendorPlan: string): Promise<void> {
    const config = await this.platformConfigService.getPlanConfig(vendorPlan);
    if (config.maxEmailsPerMonth === 0) return; // 0 = ilimitado
    const sent = await this.getVendorEmailCount(vendorId);
    if (sent >= config.maxEmailsPerMonth) {
      throw new BadRequestException(
        `Limite de emails atingido (${config.maxEmailsPerMonth}/mes). Faca upgrade do seu plano para enviar mais emails.`,
      );
    }
  }

  async sendVendorEmail(
    vendorId: string,
    vendorPlan: string,
    to: string,
    name: string,
    subject: string,
    html: string,
  ): Promise<void> {
    await this.checkVendorEmailLimit(vendorId, vendorPlan);
    try {
      await this.sendEmail(to, subject, html);
      this.logger.log(`Email do vendor enviado para ${to}`);
      await this.saveLog({ type: 'EMAIL', to, userName: name, subject, message: html, success: true, error: null, vendorId });
    } catch (error) {
      this.logger.error(`Erro ao enviar email do vendor para ${to}`, error);
      await this.saveLog({ type: 'EMAIL', to, userName: name, subject, message: html, success: false, error: String(error), vendorId });
      throw error;
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
