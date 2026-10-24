import { Injectable, BadRequestException, Logger, OnModuleDestroy, Inject } from '@nestjs/common';
import { randomInt } from 'crypto';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { MailService } from '../mail/mail.service';
import { OTP_STORE } from './otp-store';
// `import type` porque o tipo aparece numa assinatura decorada e o TS, com
// isolatedModules + emitDecoratorMetadata, exige que tipo-only venha assim.
import type { OtpStore } from './otp-store';

/**
 * KAN-231: janela em que uma verificacao bem-sucedida continua valendo como
 * prova para concluir o cadastro. O usuario verifica o codigo e tem esse tempo
 * para finalizar o registro.
 */
const VERIFIED_PROOF_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class OtpService implements OnModuleDestroy {
  private readonly logger = new Logger(OtpService.name);

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
  // KAN-295: o estado (codigos e provas) saiu do processo e foi para o store
  // injetado — Redis em producao, memoria em dev/teste. Com duas instancias da
  // API, um Map aqui dentro significava "o codigo que o cliente recebeu nao
  // existe nesta instancia": erro intermitente, sem padrao visivel.
  //
  // A expiracao agora e do store (TTL do Redis); nao ha mais varredura
  // periodica neste servico. As chaves continuam "phone:559..." / "email:...".
  constructor(
    private whatsAppService: WhatsAppService,
    private mailService: MailService,
    @Inject(OTP_STORE) private readonly store: OtpStore,
  ) {}

  async onModuleDestroy() {
    await this.store.encerrar();
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
  consumePhoneVerification(phone: string): Promise<boolean> {
    return this.store.consumirVerificado(this.phoneKey(phone));
  }

  /** Idem para e-mail. */
  consumeEmailVerification(email: string): Promise<boolean> {
    return this.store.consumirVerificado(this.emailKey(email));
  }

  private generateCode(): string {
    // KAN-280: Math.random nao e criptografico — num espaco de so 10^6 codigos,
    // previsibilidade do PRNG e risco real. randomInt usa CSPRNG.
    return randomInt(100000, 1000000).toString();
  }

  async sendPhoneCode(phone: string, fallbackEmail?: string): Promise<{ method: 'whatsapp' | 'email' }> {
    const key = this.phoneKey(phone);
    const existing = await this.store.pegar(key);

    // Rate limit: 1 codigo a cada 60s
    if (existing && existing.expiresAt - 9 * 60 * 1000 > Date.now()) {
      throw new BadRequestException('Aguarde 60 segundos para reenviar o codigo');
    }

    const code = this.generateCode();
    await this.store.gravar(key, { code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

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

    // KAN-280 (SEGURANCA): o WhatsApp falhou, entao o codigo gerado para ESTE
    // telefone NAO chegou a ninguem — descarta a entrada. Antes, o mesmo codigo
    // (indexado pelo telefone) era reenviado para um `fallbackEmail` ARBITRARIO
    // e o app seguia verificando pelo TELEFONE: quem pedia o codigo do numero de
    // outra pessoa, informando o proprio email, recebia o codigo e "verificava"
    // o telefone alheio — takeover de numero. O fallback continua existindo, mas
    // passa a verificar o EMAIL (o canal que de fato recebe o codigo): gera um
    // codigo proprio sob a chave do email. Assim ninguem reivindica um telefone
    // sem prova de posse via WhatsApp, e quem se cadastra com WhatsApp fora do ar
    // ainda conclui provando o proprio e-mail.
    await this.store.apagar(key);

    if (fallbackEmail) {
      // sendEmailCode gera e grava o codigo sob a chave do email e retorna
      // { method: 'email' } — a verificacao subsequente e por email.
      return this.sendEmailCode(fallbackEmail);
    }

    throw new BadRequestException('Nao foi possivel enviar o codigo por WhatsApp. Verifique o numero.');
  }

  async sendEmailCode(email: string, fallbackPhone?: string): Promise<{ method: 'email' | 'whatsapp' }> {
    const key = this.emailKey(email);
    const existing = await this.store.pegar(key);

    if (existing && existing.expiresAt - 9 * 60 * 1000 > Date.now()) {
      throw new BadRequestException('Aguarde 60 segundos para reenviar o codigo');
    }

    const code = this.generateCode();
    await this.store.gravar(key, { code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

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

      await this.store.apagar(key);
      throw new BadRequestException('Nao foi possivel enviar o codigo por email nem por WhatsApp.');
    }
  }

  verifyPhoneCode(phone: string, code: string): Promise<boolean> {
    return this.verifyCode(this.phoneKey(phone), code);
  }

  verifyEmailCode(email: string, code: string): Promise<boolean> {
    return this.verifyCode(this.emailKey(email), code);
  }

  private async verifyCode(key: string, code: string): Promise<boolean> {
    const entry = await this.store.pegar(key);

    if (!entry) {
      throw new BadRequestException('Codigo nao encontrado. Solicite um novo.');
    }

    if (entry.expiresAt < Date.now()) {
      await this.store.apagar(key);
      throw new BadRequestException('Codigo expirado. Solicite um novo.');
    }

    // Incremento ATOMICO no store: com duas requisicoes simultaneas, um
    // read-modify-write local deixaria o contador atras do numero real de
    // palpites — e o limite de 5 e a unica barreira contra forca bruta num
    // espaco de 10^6 codigos.
    const attempts = await this.store.contarTentativa(key);
    if (attempts > 5) {
      // KAN-280: NAO apaga a entrada. O cooldown de reenvio e derivado da
      // EXISTENCIA dela — apagar zerava o cooldown junto, entao errar 5 vezes e
      // pedir codigo novo IMEDIATAMENTE virava um loop de forca bruta (~5
      // palpites + 1 reenvio por rodada) e de bombardeio de WhatsApp/email na
      // vitima. A entrada fica, com o codigo envenenado (nunca casa) e, na
      // PRIMEIRA vez que estoura, o cooldown re-armado — so na primeira, senao
      // um atacante espameando verify bloquearia o reenvio do dono para sempre.
      if (attempts === 6) {
        await this.store.envenenar(key, Date.now() + 10 * 60 * 1000);
      }
      throw new BadRequestException('Muitas tentativas. Solicite um novo codigo.');
    }

    // Codigo envenenado (string vazia) nunca casa, nem com `code` vazio na
    // requisicao: o `!entry.code` barra antes da comparacao.
    if (!entry.code || entry.code !== code) {
      throw new BadRequestException('Codigo incorreto.');
    }

    await this.store.apagar(key);
    // KAN-231: deixa a prova de verificacao para o cadastro consumir.
    await this.store.marcarVerificado(key, Date.now() + VERIFIED_PROOF_TTL_MS);
    return true;
  }
}
