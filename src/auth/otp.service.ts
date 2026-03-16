import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { MailService } from '../mail/mail.service';

interface OtpEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  // key = "phone:5599999999" or "email:user@mail.com"
  private readonly store = new Map<string, OtpEntry>();

  // Limpa entradas expiradas a cada 5 min
  constructor(
    private whatsAppService: WhatsAppService,
    private mailService: MailService,
  ) {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (entry.expiresAt < now) this.store.delete(key);
      }
    }, 5 * 60 * 1000);
  }

  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async sendPhoneCode(phone: string): Promise<boolean> {
    const key = `phone:${phone.replace(/\D/g, '')}`;
    const existing = this.store.get(key);

    // Rate limit: 1 codigo a cada 60s
    if (existing && existing.expiresAt - 9 * 60 * 1000 > Date.now()) {
      throw new BadRequestException('Aguarde 60 segundos para reenviar o codigo');
    }

    const code = this.generateCode();
    this.store.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

    const sent = await this.whatsAppService.sendText(
      phone,
      `🔐 *Codigo de verificacao*\n\n` +
      `Seu codigo: *${code}*\n\n` +
      `Valido por 10 minutos.\n` +
      `Nao compartilhe este codigo.`,
    );

    if (!sent) {
      this.store.delete(key);
      throw new BadRequestException('Nao foi possivel enviar o codigo por WhatsApp. Verifique o numero.');
    }

    this.logger.log(`OTP enviado por WhatsApp para ${phone}`);
    return true;
  }

  async sendEmailCode(email: string): Promise<boolean> {
    const key = `email:${email.toLowerCase()}`;
    const existing = this.store.get(key);

    if (existing && existing.expiresAt - 9 * 60 * 1000 > Date.now()) {
      throw new BadRequestException('Aguarde 60 segundos para reenviar o codigo');
    }

    const code = this.generateCode();
    this.store.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

    try {
      await this.mailService.sendVerificationCode(email, code);
      this.logger.log(`OTP enviado por email para ${email}`);
      return true;
    } catch {
      this.store.delete(key);
      throw new BadRequestException('Nao foi possivel enviar o codigo por email.');
    }
  }

  verifyPhoneCode(phone: string, code: string): boolean {
    const key = `phone:${phone.replace(/\D/g, '')}`;
    return this.verifyCode(key, code);
  }

  verifyEmailCode(email: string, code: string): boolean {
    const key = `email:${email.toLowerCase()}`;
    return this.verifyCode(key, code);
  }

  private verifyCode(key: string, code: string): boolean {
    const entry = this.store.get(key);

    if (!entry) {
      throw new BadRequestException('Codigo nao encontrado. Solicite um novo.');
    }

    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      throw new BadRequestException('Codigo expirado. Solicite um novo.');
    }

    entry.attempts++;
    if (entry.attempts > 5) {
      this.store.delete(key);
      throw new BadRequestException('Muitas tentativas. Solicite um novo codigo.');
    }

    if (entry.code !== code) {
      throw new BadRequestException('Codigo incorreto.');
    }

    this.store.delete(key);
    return true;
  }
}
