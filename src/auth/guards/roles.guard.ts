import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { UserRole } from '../../common/enums';

export const ROLES_KEY = 'roles';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles) return true;

    const ctx = GqlExecutionContext.create(context);
    const user = ctx.getContext().req?.user;

    // KAN-253: sem este null-check, usar o RolesGuard sem o GqlAuthGuard antes
    // (ou fora de ordem) estourava TypeError -> 500 em vez de 403. Hoje todos
    // os resolvers colocam o GqlAuthGuard primeiro, entao ja falha fechado;
    // isto e defesa em profundidade para nao virar bypass num refactor futuro.
    if (!user) return false;

    // SUPERADMIN tem acesso a tudo
    if (user.role === UserRole.SUPERADMIN) return true;

    return requiredRoles.includes(user.role);
  }
}
