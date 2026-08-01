import { Injectable, Inject, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { PubSub } from 'graphql-subscriptions';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { AppUsersService } from '../users/app-users.service';
import { VendorUsersService } from '../users/vendor-users.service';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { RegisterAppInput } from './dto/register-app.input';
import { RegisterVendorInput } from './dto/register-vendor.input';
import { AppAuthResponse } from './dto/app-auth-response';
import { VendorAuthResponse } from './dto/vendor-auth-response';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { peppered } from '../common/utils/pepper';
import { fetchWithTimeout } from '../common/utils/fetch-with-timeout'; // KAN-253
import { OtpService } from './otp.service'; // KAN-231

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private appUsersService: AppUsersService,
    private vendorUsersService: VendorUsersService,
    private jwtService: JwtService,
    @InjectRepository(AppUser)
    private appUserRepo: Repository<AppUser>,
    @InjectRepository(VendorUser)
    private vendorUserRepo: Repository<VendorUser>,
    @Inject(PUB_SUB) private pubSub: PubSub,
    // KAN-231: para consumir a prova de verificacao do OTP no registro.
    private otpService: OtpService,
  ) {}

  private generateSessionToken(): string {
    return randomBytes(32).toString('hex');
  }

  private async signWithSession(userId: string, role: string, userType: 'app' | 'vendor'): Promise<string> {
    const sessionToken = this.generateSessionToken();
    if (userType === 'vendor') {
      await this.vendorUserRepo.update(userId, { sessionToken });
    } else {
      await this.appUserRepo.update(userId, { sessionToken });
    }
    return this.jwtService.sign({ sub: userId, role, userType, sessionToken });
  }

  async checkActiveSession(email: string, userType: string): Promise<boolean> {
    if (userType === 'vendor') {
      const user = await this.vendorUsersService.findByEmail(email);
      return !!user?.sessionToken;
    }
    const user = await this.appUsersService.findByEmail(email);
    return !!user?.sessionToken;
  }

  async validateRegistration(email: string, cpf: string, phone: string, userType: string) {
    if (userType === 'vendor') {
      return this.vendorUsersService.validateRegistration(email, cpf, phone);
    }
    return this.appUsersService.validateRegistration(email, cpf, phone);
  }

  async markEmailVerified(userId: string, userType: string): Promise<void> {
    if (userType === 'vendor') {
      await this.vendorUserRepo.update(userId, { emailVerified: true });
    } else {
      await this.appUserRepo.update(userId, { emailVerified: true });
    }
  }

  /**
   * KAN-231: o OTP era contornavel. `registerApp` e uma mutation publica e nao
   * consumia nenhum estado da verificacao, entao dava para cadastrar pulando o
   * codigo — e `create()` ainda gravava `phoneVerified: true` fixo, ou seja, o
   * campo mentia para todo mundo.
   *
   * Agora o registro consome a prova deixada pelo OtpService e grava
   * `phoneVerified` conforme a realidade.
   *
   * A EXIGENCIA (bloquear quem nao verificou) fica atras de
   * `REQUIRE_OTP_ON_REGISTER=true`. Default DESLIGADO de proposito: ligar isso
   * muda o fluxo de cadastro e precisa ser feito junto com o app mobile, senao
   * quebra o registro de quem ja esta em produção.
   */
  async registerApp(input: RegisterAppInput): Promise<AppAuthResponse> {
    const phoneVerified = this.otpService.consumePhoneVerification(input.phone);

    if (process.env.REQUIRE_OTP_ON_REGISTER === 'true' && !phoneVerified) {
      throw new BadRequestException(
        'Verifique seu telefone antes de concluir o cadastro.',
      );
    }

    const user = await this.appUsersService.create(input, phoneVerified);
    const accessToken = await this.signWithSession(user.id, user.role, 'app');
    return { accessToken, user };
  }

  async loginApp(email: string, password: string, forceLogin: boolean = false): Promise<AppAuthResponse> {
    const user = await this.appUsersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Email nao encontrado');
    }

    const passwordValid = await bcrypt.compare(peppered(password), user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Credenciais invalidas');
    }

    // SEGURANCA: conta desativada pelo superadmin nao pode emitir token novo.
    // Sem isto, banir alguem nao adiantava — bastava logar de novo.
    if (user.isActive === false) {
      throw new UnauthorizedException('Esta conta esta desativada. Fale com o suporte.');
    }

    if (user.sessionToken && !forceLogin) {
      throw new BadRequestException('ACTIVE_SESSION');
    }

    if (user.sessionToken && forceLogin) {
      this.pubSub.publish('sessionKicked', { sessionKicked: { userId: user.id, userType: 'app' } });
    }

    const accessToken = await this.signWithSession(user.id, user.role, 'app');
    return { accessToken, user };
  }

  /** KAN-231: mesmo tratamento do registerApp (ver comentario acima). */
  async registerVendor(input: RegisterVendorInput): Promise<VendorAuthResponse> {
    const phoneVerified = this.otpService.consumePhoneVerification(input.phone);

    if (process.env.REQUIRE_OTP_ON_REGISTER === 'true' && !phoneVerified) {
      throw new BadRequestException(
        'Verifique seu telefone antes de concluir o cadastro.',
      );
    }

    const user = await this.vendorUsersService.create(input, phoneVerified);
    const accessToken = await this.signWithSession(user.id, user.role, 'vendor');
    return { accessToken, user };
  }

  async loginVendor(email: string, password: string, forceLogin: boolean = false): Promise<VendorAuthResponse> {
    const user = await this.vendorUsersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Email nao encontrado');
    }

    const passwordValid = await bcrypt.compare(peppered(password), user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Credenciais invalidas');
    }

    // SEGURANCA: idem loginApp — vendedor banido nao emite token novo.
    if (user.isActive === false) {
      throw new UnauthorizedException('Esta conta esta desativada. Fale com o suporte.');
    }

    const accessToken = await this.signWithSession(user.id, user.role, 'vendor');
    return { accessToken, user };
  }

  // A#1: ANTES o logout zerava o sessionToken (null). Mas o `validate()` só
  // rejeita quando o token armazenado EXISTE e difere — com null, a checagem era
  // pulada e QUALQUER JWT ainda não expirado continuava válido após o logout (até
  // 7 dias). Agora rotacionamos para um novo valor aleatório: nenhum JWT emitido
  // antes casa mais, então todos são invalidados de fato. Um novo login gera um
  // novo sessionToken e um JWT que casa.
  async logoutApp(userId: string): Promise<void> {
    await this.appUserRepo.update(userId, { sessionToken: this.generateSessionToken() });
  }

  async logoutVendor(userId: string): Promise<void> {
    await this.vendorUserRepo.update(userId, { sessionToken: this.generateSessionToken() });
  }

  async requestPasswordResetApp(email: string): Promise<string> {
    return this.appUsersService.requestPasswordReset(email);
  }

  async requestPasswordResetVendor(email: string): Promise<string> {
    return this.vendorUsersService.requestPasswordReset(email);
  }

  async resetPasswordApp(token: string, newPassword: string): Promise<boolean> {
    return this.appUsersService.resetPassword(token, newPassword);
  }

  async resetPasswordVendor(token: string, newPassword: string): Promise<boolean> {
    return this.vendorUsersService.resetPassword(token, newPassword);
  }

  // Client_ids aceitos. Web (vendor panel) e o app mobile (fluxo web via backend)
  // usam o mesmo GOOGLE_CLIENT_ID. GOOGLE_ALLOWED_AUDIENCES (CSV) permite adicionar
  // outros (Android/iOS) no futuro sem mexer no codigo.
  private getAllowedGoogleAudiences(): string[] {
    const raw = process.env.GOOGLE_ALLOWED_AUDIENCES || process.env.GOOGLE_CLIENT_ID || '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // KAN-213: valida que o token foi emitido PARA esta aplicacao. Sem isto, um token
  // Google valido emitido para OUTRO app era aceito (confusao de audiencia ->
  // account takeover). Checa o campo aud contra a lista permitida.
  private assertGoogleAudience(aud: string | undefined): void {
    const allowed = this.getAllowedGoogleAudiences();
    if (allowed.length === 0) {
      // Sem GOOGLE_CLIENT_ID configurado seria uma misconfig; nao trava o login,
      // mas registra para nao passar despercebido.
      this.logger.error('GOOGLE_CLIENT_ID/GOOGLE_ALLOWED_AUDIENCES ausente — audiencia do token Google NAO validada.');
      return;
    }
    if (!aud || !allowed.includes(aud)) {
      throw new BadRequestException('Token Google nao emitido para esta aplicacao.');
    }
  }

  private async verifyGoogleToken(token: string) {
    // Try as id_token first (JWT format, has dots)
    if (token.includes('.')) {
      const res = await fetchWithTimeout(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
      if (res.ok) {
        const payload = await res.json();
        if (payload.email) {
          this.assertGoogleAudience(payload.aud);
          return payload;
        }
      }
    }
    // Access_token (code flow): userinfo nao traz aud, entao validamos a audiencia
    // via tokeninfo?access_token antes de confiar no perfil.
    const infoRes = await fetchWithTimeout(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
    if (!infoRes.ok) throw new BadRequestException('Token Google invalido');
    const info = await infoRes.json();
    this.assertGoogleAudience(info.aud || info.azp);

    const res = await fetchWithTimeout('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new BadRequestException('Token Google invalido');
    const payload = await res.json();
    if (!payload.email) throw new BadRequestException('Conta Google sem email');
    return payload;
  }

  async registerAppWithGoogle(idToken: string, phone: string, cpf: string): Promise<AppAuthResponse> {
    const { sub: googleId, email, name, email_verified } = await this.verifyGoogleToken(idToken);
    // Check if already exists
    const existing = await this.appUserRepo.findOne({ where: [{ email }, { googleId }] });
    if (existing) throw new BadRequestException('Ja existe uma conta com este email');
    const user = await this.appUsersService.create({
      name: name || email.split('@')[0],
      email,
      password: '',
      phone,
      cpf,
    });
    user.googleId = googleId;
    user.emailVerified = !!email_verified;
    user.password = '';
    await this.appUserRepo.save(user);
    const accessToken = await this.signWithSession(user.id, user.role, 'app');
    return { accessToken, user };
  }

  async registerVendorWithGoogle(idToken: string, phone: string, cpf: string): Promise<VendorAuthResponse> {
    const { sub: googleId, email, name, email_verified } = await this.verifyGoogleToken(idToken);
    const existing = await this.vendorUserRepo.findOne({ where: [{ email }, { googleId }] });
    if (existing) throw new BadRequestException('Ja existe uma conta com este email');
    const user = await this.vendorUsersService.create({
      name: name || email.split('@')[0],
      email,
      password: '',
      phone,
      cpf,
    });
    user.googleId = googleId;
    user.emailVerified = !!email_verified;
    user.password = '';
    await this.vendorUserRepo.save(user);
    const accessToken = await this.signWithSession(user.id, user.role, 'vendor');
    return { accessToken, user };
  }

  async googleAuthVendor(idToken: string, forceLogin: boolean = false): Promise<VendorAuthResponse> {
    const { sub: googleId, email, name, email_verified } = await this.verifyGoogleToken(idToken);

    let user = await this.vendorUserRepo.findOne({ where: { googleId } });
    if (!user) {
      user = await this.vendorUserRepo.findOne({ where: { email } });
      if (user) {
        // A#3: só vincula uma conta existente (por email) se o email do Google
        // for verificado. Sem isso, um token Google com email não-verificado
        // igual ao da vítima (viável em domínio Google Workspace do atacante)
        // vincularia o googleId dele à conta da vítima → takeover.
        if (!email_verified) {
          throw new BadRequestException('Email Google nao verificado. Nao e possivel vincular a conta.');
        }
        user.googleId = googleId;
        user.emailVerified = true;
        await this.vendorUserRepo.save(user);
      }
    }
    if (!user) throw new BadRequestException('GOOGLE_NO_ACCOUNT');

    const accessToken = await this.signWithSession(user.id, user.role, 'vendor');
    return { accessToken, user };
  }

  async googleAuthMobile(userInfo: { sub: string; email: string; name?: string; email_verified?: boolean }, userType: string) {
    const { sub: googleId, email, email_verified } = userInfo;
    // A#6: este método NÃO está ligado a nenhum resolver hoje (dead code) e ainda
    // confia num userInfo cru sem verificar o token Google. Se um dia for exposto,
    // precisa verificar o token (verifyGoogleToken + assertGoogleAudience) antes.
    // Por ora, ao menos exige email verificado para vincular por email (A#3).

    if (userType === 'vendor') {
      let user = await this.vendorUserRepo.findOne({ where: { googleId } });
      if (!user) {
        user = await this.vendorUserRepo.findOne({ where: { email } });
        if (user) {
          if (!email_verified) {
            throw new BadRequestException('Email Google nao verificado. Nao e possivel vincular a conta.');
          }
          user.googleId = googleId;
          user.emailVerified = true;
          await this.vendorUserRepo.save(user);
        }
      }
      if (!user) throw new BadRequestException('GOOGLE_NO_ACCOUNT');

      const accessToken = await this.signWithSession(user.id, user.role, 'vendor');
      return { accessToken, user };
    }

    let user = await this.appUserRepo.findOne({ where: { googleId } });
    if (!user) {
      user = await this.appUserRepo.findOne({ where: { email } });
      if (user) {
        if (!email_verified) {
          throw new BadRequestException('Email Google nao verificado. Nao e possivel vincular a conta.');
        }
        user.googleId = googleId;
        user.emailVerified = true;
        await this.appUserRepo.save(user);
      }
    }
    if (!user) throw new BadRequestException('GOOGLE_NO_ACCOUNT');

    // Google auth always overrides — notify old session if exists
    if (user.sessionToken) {
      this.pubSub.publish('sessionKicked', { sessionKicked: { userId: user.id, userType: 'app' } });
    }

    const accessToken = await this.signWithSession(user.id, user.role, 'app');
    return { accessToken, user };
  }

  async googleAuthApp(idToken: string): Promise<AppAuthResponse> {
    const { sub: googleId, email, email_verified } = await this.verifyGoogleToken(idToken);

    let user = await this.appUserRepo.findOne({ where: { googleId } });
    if (!user) {
      user = await this.appUserRepo.findOne({ where: { email } });
      if (user) {
        // A#3: só vincula por email se o email do Google for verificado (evita
        // account takeover via email não-verificado).
        if (!email_verified) {
          throw new BadRequestException('Email Google nao verificado. Nao e possivel vincular a conta.');
        }
        user.googleId = googleId;
        user.emailVerified = true;
        await this.appUserRepo.save(user);
      }
    }
    if (!user) throw new BadRequestException('GOOGLE_NO_ACCOUNT');

    // Google auth always overrides — notify old session if exists
    if (user.sessionToken) {
      this.pubSub.publish('sessionKicked', { sessionKicked: { userId: user.id, userType: 'app' } });
    }

    const accessToken = await this.signWithSession(user.id, user.role, 'app');
    return { accessToken, user };
  }
}
