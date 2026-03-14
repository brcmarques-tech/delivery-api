import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { AuthService } from './auth.service';
import { AppAuthResponse } from './dto/app-auth-response';
import { VendorAuthResponse } from './dto/vendor-auth-response';
import { RegisterAppInput } from './dto/register-app.input';
import { RegisterVendorInput } from './dto/register-vendor.input';
import { LoginInput } from './dto/login.input';

@Resolver()
export class AuthResolver {
  constructor(private authService: AuthService) {}

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
}
