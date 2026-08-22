import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThanOrEqual } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { NotificationLog } from './entities/notification-log.entity';

@Injectable()
export class MailService {
  private resend: Resend | null;
  private readonly logger = new Logger(MailService.name);
  private lastSendTime = 0;
  private sendQueue = Promise.resolve();

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
    return this.configService.get('MAIL_FROM', 'BCM TECH SHOPPING AG <onboarding@resend.dev>');
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
    // Rate limit: max 4 emails/segundo (Resend permite 5, margem de seguranca)
    await new Promise<void>((resolve) => {
      this.sendQueue = this.sendQueue.then(async () => {
        const now = Date.now();
        const elapsed = now - this.lastSendTime;
        if (elapsed < 250) {
          await new Promise((r) => setTimeout(r, 250 - elapsed));
        }
        this.lastSendTime = Date.now();
        resolve();
      });
    });
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
          <h1 style="color: white; margin: 0;">bcmTech Shopping</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #2D3436;">Parabens, ${name}!</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Seu cadastro como <strong>${roleLabel}</strong> foi <span style="color: #27AE60; font-weight: bold;">aprovado</span> na plataforma bcmTech Shopping.
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
          <h1 style="color: white; margin: 0;">bcmTech Shopping</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #2D3436;">Ola, ${name}</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Infelizmente seu cadastro como <strong>${roleLabel}</strong> nao foi aprovado na plataforma bcmTech Shopping.
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
          <h1 style="color: white; margin: 0;">bcmTech Shopping</h1>
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
          <h1 style="color: white; margin: 0;">bcmTech Shopping</h1>
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
          <h1 style="color: white; margin: 0;">bcmTech Shopping</h1>
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

  async sendAdminActionEmail(adminEmail: string, adminName: string, action: string, details: string): Promise<void> {
    const subject = `bcmTech Admin - ${action}`;
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #2D3436; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #FF6B35; margin: 0;">bcmTech Admin</h1>
          <p style="color: #ddd; margin: 5px 0 0 0; font-size: 12px;">Confirmacao de acao</p>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #2D3436; margin-top: 0;">${action}</h2>
          <div style="background: white; border: 1px solid #eee; border-radius: 8px; padding: 20px; margin: 15px 0;">
            <p style="color: #555; font-size: 14px; line-height: 1.8; margin: 0; white-space: pre-line;">${details}</p>
          </div>
          <div style="background: #f0f0f0; border-radius: 8px; padding: 12px; margin-top: 15px;">
            <p style="color: #777; font-size: 12px; margin: 0;"><strong>Admin:</strong> ${adminName} (${adminEmail})</p>
            <p style="color: #777; font-size: 12px; margin: 5px 0 0 0;"><strong>Data/hora:</strong> ${now}</p>
          </div>
          <div style="border-top: 1px solid #eee; margin-top: 20px; padding-top: 15px; text-align: center;">
            <p style="color: #999; font-size: 11px; margin: 0;">
              Este email foi enviado automaticamente como confirmacao de acao administrativa.
            </p>
          </div>
        </div>
      </div>
    `;
    try {
      await this.sendEmail(adminEmail, subject, html);
      this.logger.log(`Email de confirmacao admin enviado para ${adminEmail}: ${action}`);
      await this.saveLog({ type: 'EMAIL', to: adminEmail, userName: adminName, subject, message: `Admin: ${action} - ${details}`, success: true, error: null });
    } catch (error) {
      this.logger.error(`Erro ao enviar email de confirmacao admin para ${adminEmail}`, error);
      await this.saveLog({ type: 'EMAIL', to: adminEmail, userName: adminName, subject, message: `Admin: ${action} - ${details}`, success: false, error: String(error) });
    }
  }

  async sendAntifraudReviewEmail(orderNumber: string, customerName: string, total: number, chargeId: string): Promise<void> {
    const supportEmail = 'suporte@bcmtech.com.br';
    const subject = `bcmTech - Pedido #${orderNumber} bloqueado por antifraude`;
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #E67E22; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">bcmTech Shopping</h1>
          <p style="color: #fff; margin: 5px 0 0 0; font-size: 14px;">Revisao de Antifraude</p>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #E67E22; margin-top: 0;">Pedido requer reprocessamento</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            O pedido abaixo foi <strong>aprovado pelo adquirente</strong> mas <strong>bloqueado pelo antifraude</strong> do Pagar.me.
            E necessario reprocessar manualmente no dashboard.
          </p>
          <div style="background: white; border: 1px solid #eee; border-radius: 8px; padding: 20px; margin: 15px 0;">
            <p style="color: #555; font-size: 14px; margin: 0;"><strong>Pedido:</strong> #${orderNumber}</p>
            <p style="color: #555; font-size: 14px; margin: 8px 0;"><strong>Cliente:</strong> ${customerName}</p>
            <p style="color: #555; font-size: 14px; margin: 8px 0;"><strong>Valor:</strong> R$ ${total.toFixed(2)}</p>
            <p style="color: #555; font-size: 14px; margin: 8px 0;"><strong>Charge ID:</strong> ${chargeId}</p>
            <p style="color: #999; font-size: 12px; margin: 8px 0 0 0;"><strong>Data:</strong> ${now}</p>
          </div>
          <div style="text-align: center; margin-top: 20px;">
            <a href="https://dash.pagar.me" style="display: inline-block; background: #E67E22; color: white; padding: 12px 30px; border-radius: 8px; font-size: 16px; font-weight: bold; text-decoration: none;">
              Abrir Dashboard Pagar.me
            </a>
          </div>
          <p style="color: #777; font-size: 13px; margin-top: 20px; text-align: center;">
            Apos reprocessar, o webhook atualizara o pedido automaticamente.
          </p>
          <div style="border-top: 1px solid #eee; margin-top: 20px; padding-top: 15px; text-align: center;">
            <p style="color: #999; font-size: 11px; margin: 0;">
              Este email foi enviado automaticamente pelo sistema bcmTech Shopping.
            </p>
          </div>
        </div>
      </div>
    `;
    try {
      await this.sendEmail(supportEmail, subject, html);
      this.logger.log(`Email de antifraude enviado para ${supportEmail} - pedido #${orderNumber}`);
      await this.saveLog({ type: 'EMAIL', to: supportEmail, userName: 'Suporte', subject, message: `Pedido #${orderNumber} bloqueado por antifraude. Charge: ${chargeId}`, success: true, error: null });
    } catch (error) {
      this.logger.error(`Erro ao enviar email de antifraude para ${supportEmail}`, error);
      await this.saveLog({ type: 'EMAIL', to: supportEmail, userName: 'Suporte', subject, message: `Pedido #${orderNumber} bloqueado por antifraude. Charge: ${chargeId}`, success: false, error: String(error) });
    }
  }

  async retryFailedEmails(): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    // BUGFIX: filtros movidos para o SQL. Antes o WHERE trazia TODO log com
    // success=false e filtrava retryCount/data em memoria — logs permanentemente
    // falhos (success=false, retryCount=1) ficam para sempre e eram relidos a
    // cada hora, num conjunto que so cresce. Pior: ignorava o soft-delete.
    // `deletedAt` e um @Column comum (nao @DeleteDateColumn), entao o TypeORM
    // NAO o exclui sozinho; deleteNotification/clearAllNotifications so setam
    // deletedAt. Um e-mail falho que o admin apagou era reenviado uma hora
    // depois. Agora: so os que faltam tentar (retryCount 0), fora da janela de
    // 1h e nao apagados — coerente com o filtro do resolver (deletedAt IsNull).
    const failedLogs = await this.logRepository.find({
      where: {
        success: false,
        retryCount: 0,
        deletedAt: IsNull(),
        createdAt: LessThanOrEqual(oneHourAgo),
      },
    });

    for (const log of failedLogs) {
      this.logger.log(`Auto-retry email para ${log.to}`);
      await this.resendEmail(log);
    }
  }

  async sendVerificationCode(to: string, code: string): Promise<void> {
    const subject = 'bcmTech - Codigo de verificacao';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #FF6B35; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">bcmTech Shopping</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
          <h2 style="color: #2D3436; text-align: center;">Codigo de verificacao</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6; text-align: center;">
            Use o codigo abaixo para verificar seu email:
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <div style="display: inline-block; background: #FF6B35; color: white; padding: 16px 40px; border-radius: 12px; font-size: 32px; font-weight: bold; letter-spacing: 8px;">
              ${code}
            </div>
          </div>
          <p style="color: #999; font-size: 14px; text-align: center;">
            Este codigo expira em 10 minutos.
          </p>
          <p style="color: #999; font-size: 14px; text-align: center;">
            Se voce nao solicitou este codigo, ignore este email.
          </p>
          <div style="border-top: 1px solid #eee; margin-top: 30px; padding-top: 15px; text-align: center;">
            <p style="color: #999; font-size: 11px; margin: 0;">
              Este email foi enviado automaticamente. Por favor, nao responda.
            </p>
          </div>
        </div>
      </div>
    `;
    await this.sendEmail(to, subject, html);
  }
}
