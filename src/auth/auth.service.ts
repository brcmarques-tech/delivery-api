import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { RegisterInput } from './dto/register.input';
import { LoginInput } from './dto/login.input';
import { AuthResponse } from './dto/auth-response';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
    const user = await this.usersService.create(input);
    const accessToken = this.jwtService.sign({ sub: user.id, role: user.role });
    return { accessToken, user };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await this.usersService.findByEmail(input.email);
    if (!user) {
      throw new UnauthorizedException('Credenciais invalidas');
    }

    const passwordValid = await bcrypt.compare(input.password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Credenciais invalidas');
    }

    const accessToken = this.jwtService.sign({ sub: user.id, role: user.role });
    return { accessToken, user };
  }
}
