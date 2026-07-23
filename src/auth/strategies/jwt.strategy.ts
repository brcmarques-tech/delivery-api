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
    // KAN-227: sem fallback literal 'fallback-secret' (publico neste repo).
    // Falha o boot se JWT_SECRET nao estiver configurado, em vez de verificar
    // tokens com um segredo conhecido — o que permitiria forjar JWTs.
    const jwtSecret = configService.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      throw new Error('JWT_SECRET nao configurado — defina no ambiente antes de subir a API.');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: jwtSecret,
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
