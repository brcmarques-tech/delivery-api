import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthResolver } from './auth.resolver';
import { AuthController } from './auth.controller';
import { OtpService } from './otp.service';
import { OTP_STORE, criarOtpStore, OtpStore } from './otp-store';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsersModule } from '../users/users.module';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';

@Module({
  imports: [
    ConfigModule,
    UsersModule,
    TypeOrmModule.forFeature([AppUser, VendorUser]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRATION') },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthResolver,
    OtpService,
    JwtStrategy,
    // KAN-295: Redis quando houver REDIS_HOST, memoria (com aviso) quando nao.
    // A escolha fica AQUI, e nao dentro do servico, para o teste unitario poder
    // injetar o store de memoria sem subir Redis nenhum.
    {
      provide: OTP_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): OtpStore =>
        criarOtpStore((chave) => config.get<string>(chave)),
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
