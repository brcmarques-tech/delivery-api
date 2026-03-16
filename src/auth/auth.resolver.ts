import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { AppAuthResponse } from './dto/app-auth-response';
import { VendorAuthResponse } from './dto/vendor-auth-response';
import { RegisterAppInput } from './dto/register-app.input';
import { RegisterVendorInput } from './dto/register-vendor.input';
import { LoginInput } from './dto/login.input';
import { ValidationResult } from './dto/validation-result';
import { SendCodeInput } from './dto/send-code.input';
import { VerifyCodeInput } from './dto/verify-code.input';
import { GqlAuthGuard } from './guards/gql-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';

@Resolver()
export class AuthResolver {
  constructor(
    private authService: AuthService,
    private otpService: OtpService,
  ) {}

  // ---- Pré-validação de cadastro (público) ----

  @Mutation(() => ValidationResult)
  async validateRegistration(
    @Args('email') email: string,
    @Args('cpf') cpf: string,
    @Args('phone') phone: string,
    @Args('userType', { defaultValue: 'app' }) userType: string,
  ): Promise<ValidationResult> {
    return this.authService.validateRegistration(email, cpf, phone, userType) as any;
  }

  // ---- Verificação OTP (público, antes do cadastro) ----

  @Mutation(() => Boolean)
  async sendVerificationCode(@Args('input') input: SendCodeInput): Promise<boolean> {
    if (input.channel === 'whatsapp') {
      return this.otpService.sendPhoneCode(input.value);
    }
    return this.otpService.sendEmailCode(input.value);
  }

  @Mutation(() => Boolean)
  async verifyCode(@Args('input') input: VerifyCodeInput): Promise<boolean> {
    if (input.channel === 'whatsapp') {
      return this.otpService.verifyPhoneCode(input.value, input.code);
    }
    return this.otpService.verifyEmailCode(input.value, input.code);
  }

  // ---- Verificação de email (autenticado, pós-login) ----

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async sendEmailVerification(@Args('userType', { defaultValue: 'app' }) userType: string, @CurrentUser() user: any): Promise<boolean> {
    return this.otpService.sendEmailCode(user.email);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async confirmEmailVerification(
    @Args('code') code: string,
    @Args('userType', { defaultValue: 'app' }) userType: string,
    @CurrentUser() user: any,
  ): Promise<boolean> {
    this.otpService.verifyEmailCode(user.email, code);
    await this.authService.markEmailVerified(user.id, userType);
    return true;
  }

  // ---- Registro e Login ----

  @Mutation(() => AppAuthResponse)
  async registerApp(@Args('input') input: RegisterAppInput): Promise<AppAuthResponse> {
    return this.authService.registerApp(input);
  }

  @Mutation(() => AppAuthResponse)
  async loginApp(@Args('input') input: LoginInput): Promise<AppAuthResponse> {
    return this.authService.loginApp(input.email, input.password);
  }

  @Mutation(() => VendorAuthResponse)
  async registerVendor(@Args('input') input: RegisterVendorInput): Promise<VendorAuthResponse> {
    return this.authService.registerVendor(input);
  }

  @Mutation(() => VendorAuthResponse)
  async loginVendor(@Args('input') input: LoginInput): Promise<VendorAuthResponse> {
    return this.authService.loginVendor(input.email, input.password);
  }

  @Mutation(() => String)
  async requestPasswordResetApp(@Args('email') email: string): Promise<string> {
    return this.authService.requestPasswordResetApp(email);
  }

  @Mutation(() => String)
  async requestPasswordResetVendor(@Args('email') email: string): Promise<string> {
    return this.authService.requestPasswordResetVendor(email);
  }

  @Mutation(() => Boolean)
  async resetPassword(
    @Args('token') token: string,
    @Args('newPassword') newPassword: string,
    @Args('type', { defaultValue: 'app' }) type: string,
  ): Promise<boolean> {
    if (type === 'vendor') {
      return this.authService.resetPasswordVendor(token, newPassword);
    }
    return this.authService.resetPasswordApp(token, newPassword);
  }

  // ---- Google OAuth ----

  @Mutation(() => VendorAuthResponse)
  async googleAuthVendor(@Args('idToken') idToken: string): Promise<VendorAuthResponse> {
    return this.authService.googleAuthVendor(idToken);
  }

  @Mutation(() => AppAuthResponse)
  async googleAuthApp(@Args('idToken') idToken: string): Promise<AppAuthResponse> {
    return this.authService.googleAuthApp(idToken);
  }

  @Mutation(() => AppAuthResponse)
  async registerAppWithGoogle(
    @Args('idToken') idToken: string,
    @Args('phone') phone: string,
    @Args('cpf') cpf: string,
  ): Promise<AppAuthResponse> {
    return this.authService.registerAppWithGoogle(idToken, phone, cpf);
  }

  @Mutation(() => VendorAuthResponse)
  async registerVendorWithGoogle(
    @Args('idToken') idToken: string,
    @Args('phone') phone: string,
    @Args('cpf') cpf: string,
  ): Promise<VendorAuthResponse> {
    return this.authService.registerVendorWithGoogle(idToken, phone, cpf);
  }
}
