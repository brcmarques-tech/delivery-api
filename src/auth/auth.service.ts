import { Injectable, Inject, UnauthorizedException, BadRequestException } from '@nestjs/common';
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

@Injectable()
export class AuthService {
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

    const passwordValid = await bcrypt.compare(password, user.password);
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

    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Credenciais invalidas');
    }

    if (user.sessionToken && !forceLogin) {
      throw new BadRequestException('ACTIVE_SESSION');
    }

    if (user.sessionToken && forceLogin) {
      this.pubSub.publish('sessionKicked', { sessionKicked: { userId: user.id, userType: 'vendor' } });
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

  private async verifyGoogleToken(token: string) {
    // Try as id_token first (JWT format, has dots)
    if (token.includes('.')) {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
      if (res.ok) {
        const payload = await res.json();
        if (payload.email) return payload;
      }
    }
    // Try as access_token (from code flow)
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

    if (user.sessionToken && !forceLogin) {
      throw new BadRequestException('ACTIVE_SESSION');
    }
    if (user.sessionToken && forceLogin) {
      this.pubSub.publish('sessionKicked', { sessionKicked: { userId: user.id, userType: 'vendor' } });
    }

    const accessToken = await this.signWithSession(user.id, user.role, 'vendor');
    return { accessToken, user };
  }

  async googleAuthMobile(userInfo: { sub: string; email: string; name?: string; email_verified?: boolean }, userType: string, forceLogin: boolean = false) {
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

      if (user.sessionToken && !forceLogin) {
        throw new BadRequestException('ACTIVE_SESSION');
      }
      if (user.sessionToken && forceLogin) {
        this.pubSub.publish('sessionKicked', { sessionKicked: { userId: user.id, userType: 'vendor' } });
      }

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

    if (user.sessionToken && !forceLogin) {
      throw new BadRequestException('ACTIVE_SESSION');
    }
    if (user.sessionToken && forceLogin) {
      this.pubSub.publish('sessionKicked', { sessionKicked: { userId: user.id, userType: 'app' } });
    }

    const accessToken = await this.signWithSession(user.id, user.role, 'app');
    return { accessToken, user };
  }

  async googleAuthApp(idToken: string, forceLogin: boolean = false): Promise<AppAuthResponse> {
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

    if (user.sessionToken && !forceLogin) {
      throw new BadRequestException('ACTIVE_SESSION');
    }
    if (user.sessionToken && forceLogin) {
      this.pubSub.publish('sessionKicked', { sessionKicked: { userId: user.id, userType: 'app' } });
    }

    const accessToken = await this.signWithSession(user.id, user.role, 'app');
    return { accessToken, user };
  }
}
