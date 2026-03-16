import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AppUsersService } from '../users/app-users.service';
import { VendorUsersService } from '../users/vendor-users.service';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { RegisterAppInput } from './dto/register-app.input';
import { RegisterVendorInput } from './dto/register-vendor.input';
import { AppAuthResponse } from './dto/app-auth-response';
import { VendorAuthResponse } from './dto/vendor-auth-response';

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
  ) {}

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
    const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'app' });
    return { accessToken, user };
  }

  async loginApp(email: string, password: string): Promise<AppAuthResponse> {
    const user = await this.appUsersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Email nao encontrado');
    }

    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Credenciais invalidas');
    }

    const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'app' });
    return { accessToken, user };
  }

  async registerVendor(input: RegisterVendorInput): Promise<VendorAuthResponse> {
    const user = await this.vendorUsersService.create(input);
    const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'vendor' });
    return { accessToken, user };
  }

  async loginVendor(email: string, password: string): Promise<VendorAuthResponse> {
    const user = await this.vendorUsersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Email nao encontrado');
    }

    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Credenciais invalidas');
    }

    const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'vendor' });
    return { accessToken, user };
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
    const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'app' });
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
    const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'vendor' });
    return { accessToken, user };
  }

  async googleAuthVendor(idToken: string): Promise<VendorAuthResponse> {
    const { sub: googleId, email, name, email_verified } = await this.verifyGoogleToken(idToken);

    // Check if vendor already linked by googleId
    let user = await this.vendorUserRepo.findOne({ where: { googleId } });
    if (user) {
      const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'vendor' });
      return { accessToken, user };
    }

    // Check if vendor exists with same email
    user = await this.vendorUserRepo.findOne({ where: { email } });
    if (user) {
      // Link Google to existing account
      user.googleId = googleId;
      if (email_verified) user.emailVerified = true;
      await this.vendorUserRepo.save(user);
      const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'vendor' });
      return { accessToken, user };
    }

    // No account exists - return error, must register first with full data
    throw new BadRequestException('GOOGLE_NO_ACCOUNT');
  }

  async googleAuthMobile(userInfo: { sub: string; email: string; name?: string; email_verified?: boolean }, userType: string) {
    const { sub: googleId, email, email_verified } = userInfo;

    if (userType === 'vendor') {
      let user = await this.vendorUserRepo.findOne({ where: { googleId } });
      if (user) {
        const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'vendor' });
        return { accessToken, user };
      }
      user = await this.vendorUserRepo.findOne({ where: { email } });
      if (user) {
        user.googleId = googleId;
        if (email_verified) user.emailVerified = true;
        await this.vendorUserRepo.save(user);
        const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'vendor' });
        return { accessToken, user };
      }
      throw new BadRequestException('GOOGLE_NO_ACCOUNT');
    }

    let user = await this.appUserRepo.findOne({ where: { googleId } });
    if (user) {
      const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'app' });
      return { accessToken, user };
    }
    user = await this.appUserRepo.findOne({ where: { email } });
    if (user) {
      user.googleId = googleId;
      if (email_verified) user.emailVerified = true;
      await this.appUserRepo.save(user);
      const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'app' });
      return { accessToken, user };
    }
    throw new BadRequestException('GOOGLE_NO_ACCOUNT');
  }

  async googleAuthApp(idToken: string): Promise<AppAuthResponse> {
    const { sub: googleId, email, email_verified } = await this.verifyGoogleToken(idToken);

    let user = await this.appUserRepo.findOne({ where: { googleId } });
    if (user) {
      const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'app' });
      return { accessToken, user };
    }

    user = await this.appUserRepo.findOne({ where: { email } });
    if (user) {
      user.googleId = googleId;
      if (email_verified) user.emailVerified = true;
      await this.appUserRepo.save(user);
      const accessToken = this.jwtService.sign({ sub: user.id, role: user.role, userType: 'app' });
      return { accessToken, user };
    }

    throw new BadRequestException('GOOGLE_NO_ACCOUNT');
  }
}
