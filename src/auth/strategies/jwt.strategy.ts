import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AppUsersService } from '../../users/app-users.service';
import { VendorUsersService } from '../../users/vendor-users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private appUsersService: AppUsersService,
    private vendorUsersService: VendorUsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.get('JWT_SECRET') || 'fallback-secret',
    });
  }

  async validate(payload: { sub: string; userType?: string; sessionToken?: string }) {
    const userType = payload.userType || 'app';

    if (userType === 'vendor') {
      const user = await this.vendorUsersService.findById(payload.sub);
      if (!user) throw new UnauthorizedException();
      // KAN-215: mesma validacao de sessao unica que os app users ja tinham.
      // signWithSession('vendor') ja emitia o sessionToken no JWT, mas ninguem
      // conferia — logout/force-login em outra sessao nao invalidava o token
      // antigo do vendor, que ficava valido para sempre.
      if (user.sessionToken && payload.sessionToken !== user.sessionToken) {
        throw new UnauthorizedException('SESSION_EXPIRED');
      }
      return { ...user, userType: 'vendor' };
    }

    const user = await this.appUsersService.findById(payload.sub);
    if (!user) throw new UnauthorizedException();
    if (user.sessionToken && payload.sessionToken !== user.sessionToken) {
      throw new UnauthorizedException('SESSION_EXPIRED');
    }
    return { ...user, userType: 'app' };
  }
}
