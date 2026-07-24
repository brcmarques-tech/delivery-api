import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { MailService } from '../mail/mail.service';

interface OtpEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}

/**
 * KAN-231: janela em que uma verificacao bem-sucedida continua valendo como
 * prova para concluir o cadastro. O usuario verifica o codigo e tem esse tempo
 * para finalizar o registro.
 */
const VERIFIED_PROOF_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  // key = "phone:5599999999" or "email:user@mail.com"
  private readonly store = new Map<string, OtpEntry>();

  /**
   * KAN-231: prova de que o contato FOI verificado.
   *
   * Antes, `verifyCode` apenas apagava a entrada e devolvia `true` — nao
   * sobrava nenhum estado, entao o `registerApp` (mutation publica) nao tinha
   * como saber se houve verificacao. Resultado: dava para chamar o registro
   * direto e pular o OTP inteiro, enquanto `create()` gravava
   * `phoneVerified: true` fixo. A "verificacao de contato" nao era garantida
   * por nada no backend.
   *
   * Agora a verificacao deixa um registro de curta duracao, consumido no
   * cadastro (uso unico).
   */
  private readonly verified = new Map<string, number>();

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
      for (const [key, expiresAt] of this.verified) {
        if (expiresAt < now) this.verified.delete(key);
      }
    }, 5 * 60 * 1000);
  }

  private phoneKey(phone: string): string {
    return `phone:${phone.replace(/\D/g, '')}`;
  }

  private emailKey(email: string): string {
    return `email:${email.toLowerCase()}`;
  }

  /**
   * Consome a prova de verificacao de telefone (uso unico).
   * Retorna `true` se o telefone foi verificado ha pouco.
   */
  consumePhoneVerification(phone: string): boolean {
    return this.consumeVerification(this.phoneKey(phone));
  }

  /** Idem para e-mail. */
  consumeEmailVerification(email: string): boolean {
    return this.consumeVerification(this.emailKey(email));
  }

  private consumeVerification(key: string): boolean {
    const expiresAt = this.verified.get(key);
    if (!expiresAt) return false;
    this.verified.delete(key);
    return expiresAt >= Date.now();
  }

  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async sendPhoneCode(phone: string, fallbackEmail?: string): Promise<{ method: 'whatsapp' | 'email' }> {
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

    if (sent) {
      this.logger.log(`OTP enviado por WhatsApp para ${phone}`);
      return { method: 'whatsapp' };
    }

    // Fallback: enviar por email se WhatsApp falhar
    if (fallbackEmail) {
      try {
        await this.mailService.sendVerificationCode(fallbackEmail, code);
        this.logger.log(`OTP enviado por email (fallback) para ${fallbackEmail}`);
        return { method: 'email' };
      } catch {
        this.store.delete(key);
        throw new BadRequestException('Nao foi possivel enviar o codigo por WhatsApp nem por email.');
      }
    }

    this.store.delete(key);
    throw new BadRequestException('Nao foi possivel enviar o codigo por WhatsApp. Verifique o numero.');
  }

  async sendEmailCode(email: string, fallbackPhone?: string): Promise<{ method: 'email' | 'whatsapp' }> {
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
      return { method: 'email' };
    } catch {
      // Fallback: enviar por WhatsApp se email falhar
      if (fallbackPhone) {
        const sent = await this.whatsAppService.sendText(
          fallbackPhone,
          `🔐 *Codigo de verificacao*\n\nSeu codigo: *${code}*\n\nValido por 10 minutos.\nNao compartilhe este codigo.`,
        );
        if (sent) {
          this.logger.log(`OTP enviado por WhatsApp (fallback) para ${fallbackPhone}`);
          return { method: 'whatsapp' };
        }
      }

      this.store.delete(key);
      throw new BadRequestException('Nao foi possivel enviar o codigo por email nem por WhatsApp.');
    }
  }

  verifyPhoneCode(phone: string, code: string): boolean {
    return this.verifyCode(this.phoneKey(phone), code);
  }

  verifyEmailCode(email: string, code: string): boolean {
    return this.verifyCode(this.emailKey(email), code);
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
    // KAN-231: deixa a prova de verificacao para o cadastro consumir.
    this.verified.set(key, Date.now() + VERIFIED_PROOF_TTL_MS);
    return true;
  }
}
