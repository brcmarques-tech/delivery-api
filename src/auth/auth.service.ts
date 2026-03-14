import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AppUsersService } from '../users/app-users.service';
import { VendorUsersService } from '../users/vendor-users.service';
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
  ) {}

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
}
