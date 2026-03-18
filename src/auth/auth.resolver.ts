import { Resolver, Mutation, Subscription, Args } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { ObjectType, Field } from '@nestjs/graphql';
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
import { PUB_SUB } from '../pubsub/pubsub.module';

@ObjectType()
class SessionKickedPayload {
  @Field()
  userId: string;

  @Field()
  userType: string;
}

@Resolver()
export class AuthResolver {
  constructor(
    private authService: AuthService,
    private otpService: OtpService,
    @Inject(PUB_SUB) private pubSub: PubSub,
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

  @Mutation(() => String)
  async sendVerificationCode(@Args('input') input: SendCodeInput): Promise<string> {
    if (input.channel === 'whatsapp') {
      const result = await this.otpService.sendPhoneCode(input.value, input.fallbackEmail);
      return result.method;
    }
    await this.otpService.sendEmailCode(input.value);
    return 'email';
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
  async loginApp(
    @Args('input') input: LoginInput,
    @Args('forceLogin', { nullable: true, defaultValue: false }) forceLogin: boolean,
  ): Promise<AppAuthResponse> {
    return this.authService.loginApp(input.email, input.password, forceLogin);
  }

  @Mutation(() => VendorAuthResponse)
  async registerVendor(@Args('input') input: RegisterVendorInput): Promise<VendorAuthResponse> {
    return this.authService.registerVendor(input);
  }

  @Mutation(() => VendorAuthResponse)
  async loginVendor(
    @Args('input') input: LoginInput,
    @Args('forceLogin', { nullable: true, defaultValue: false }) forceLogin: boolean,
  ): Promise<VendorAuthResponse> {
    return this.authService.loginVendor(input.email, input.password, forceLogin);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async logout(@CurrentUser() user: any): Promise<boolean> {
    if (user.userType === 'vendor') {
      await this.authService.logoutVendor(user.id);
    } else {
      await this.authService.logoutApp(user.id);
    }
    return true;
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
  async googleAuthVendor(
    @Args('idToken') idToken: string,
    @Args('forceLogin', { nullable: true, defaultValue: false }) forceLogin: boolean,
  ): Promise<VendorAuthResponse> {
    return this.authService.googleAuthVendor(idToken, forceLogin);
  }

  @Mutation(() => AppAuthResponse)
  async googleAuthApp(
    @Args('idToken') idToken: string,
    @Args('forceLogin', { nullable: true, defaultValue: false }) forceLogin: boolean,
  ): Promise<AppAuthResponse> {
    return this.authService.googleAuthApp(idToken, forceLogin);
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

  // ---- Subscriptions ----

  @Subscription(() => SessionKickedPayload, {
    filter: (payload, variables) =>
      payload.sessionKicked.userId === variables.userId &&
      payload.sessionKicked.userType === variables.userType,
  })
  sessionKicked(
    @Args('userId') userId: string,
    @Args('userType', { defaultValue: 'app' }) userType: string,
  ) {
    return this.pubSub.asyncIterableIterator('sessionKicked');
  }
}
