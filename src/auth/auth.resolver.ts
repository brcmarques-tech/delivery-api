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
import { GqlThrottlerGuard } from './guards/gql-throttler.guard';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from './decorators/current-user.decorator';
import { PUB_SUB } from '../pubsub/pubsub.module';

@ObjectType()
class SessionKickedPayload {
  @Field()
  userId: string;

  @Field()
  userType: string;
}

// A#4: rate limiting nas rotas de auth (força-bruta/spam). O guard é ciente do
// GraphQL e ignora subscriptions (WS). Default 120/min; login e reset ficam mais
// estritos via @Throttle nos métodos.
@UseGuards(GqlThrottlerGuard)
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
    const result = await this.otpService.sendEmailCode(input.value, input.fallbackPhone);
    return result.method;
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
    const result = await this.otpService.sendEmailCode(user.email);
    return result.method === 'email' || result.method === 'whatsapp';
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
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
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
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestPasswordResetApp(@Args('email') email: string): Promise<string> {
    return this.authService.requestPasswordResetApp(email);
  }

  @Mutation(() => String)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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

  // ---- Subscriptions ----

  // A#5: só o próprio usuário autenticado (context.wsUser, validado no onConnect)
  // pode assinar seu sessionKicked. ANTES o filtro casava só pelos argumentos, então
  // qualquer cliente assinava `sessionKicked(userId: <vítima>)` e observava os
  // eventos de login/expulsão de qualquer conta (canal de enumeração/atividade).
  @Subscription(() => SessionKickedPayload, {
    filter: (payload, variables, context) => {
      const user = context?.wsUser;
      if (!user || user.sub !== variables.userId) return false;
      return (
        payload.sessionKicked.userId === variables.userId &&
        payload.sessionKicked.userType === variables.userType
      );
    },
  })
  sessionKicked(
    @Args('userId') userId: string,
    @Args('userType', { defaultValue: 'app' }) userType: string,
  ) {
    return this.pubSub.asyncIterableIterator('sessionKicked');
  }
}
