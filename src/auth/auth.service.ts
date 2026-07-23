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

  async registerApp(input: RegisterAppInput): Promise<AppAuthResponse> {
    const user = await this.appUsersService.create(input);
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

    if (user.sessionToken && !forceLogin) {
      throw new BadRequestException('ACTIVE_SESSION');
    }

    if (user.sessionToken && forceLogin) {
      this.pubSub.publish('sessionKicked', { sessionKicked: { userId: user.id, userType: 'app' } });
    }

    const accessToken = await this.signWithSession(user.id, user.role, 'app');
    return { accessToken, user };
  }

  async registerVendor(input: RegisterVendorInput): Promise<VendorAuthResponse> {
    const user = await this.vendorUsersService.create(input);
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

    const accessToken = await this.signWithSession(user.id, user.role, 'vendor');
    return { accessToken, user };
  }

  async logoutApp(userId: string): Promise<void> {
    await this.appUserRepo.update(userId, { sessionToken: null as any });
  }

  async logoutVendor(userId: string): Promise<void> {
    await this.vendorUserRepo.update(userId, { sessionToken: null as any });
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
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
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
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
    if (!infoRes.ok) throw new BadRequestException('Token Google invalido');
    const info = await infoRes.json();
    this.assertGoogleAudience(info.aud || info.azp);

    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
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
        user.googleId = googleId;
        if (email_verified) user.emailVerified = true;
        await this.vendorUserRepo.save(user);
      }
    }
    if (!user) throw new BadRequestException('GOOGLE_NO_ACCOUNT');

    const accessToken = await this.signWithSession(user.id, user.role, 'vendor');
    return { accessToken, user };
  }

  async googleAuthMobile(userInfo: { sub: string; email: string; name?: string; email_verified?: boolean }, userType: string) {
    const { sub: googleId, email, email_verified } = userInfo;

    if (userType === 'vendor') {
      let user = await this.vendorUserRepo.findOne({ where: { googleId } });
      if (!user) {
        user = await this.vendorUserRepo.findOne({ where: { email } });
        if (user) {
          user.googleId = googleId;
          if (email_verified) user.emailVerified = true;
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
        user.googleId = googleId;
        if (email_verified) user.emailVerified = true;
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
        user.googleId = googleId;
        if (email_verified) user.emailVerified = true;
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
