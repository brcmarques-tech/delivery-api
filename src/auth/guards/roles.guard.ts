import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { UserRole } from '../../common/enums';
import { PERMISSION_KEY } from '../decorators/permission.decorator';

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

    // SUPERADMIN tem acesso a tudo, RESPEITANDO as permissoes granulares.
    //
    // SEGURANCA: antes era um `return true` seco. O campo `permissions` do
    // superadmin era gravado pelo painel mas NUNCA lido por guard ou resolver
    // nenhum — um superadmin limitado (`{"managePayments": false}`) tinha os
    // botoes escondidos na UI e, chamando a mutation direto no /graphql, fazia
    // tudo assim mesmo. A restricao so existia na aparencia.
    if (user.role === UserRole.SUPERADMIN) {
      const permissao = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!permissao) return true; // operacao sem permissao granular declarada
      // `permissions` null/ausente = superadmin pleno (comportamento historico).
      const raw = (user as any).permissions;
      if (raw === null || raw === undefined) return true;
      let mapa: Record<string, unknown>;
      try {
        mapa = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        // Falha FECHADA: permissions corrompido nao pode virar acesso total.
        return false;
      }
      return mapa?.[permissao] !== false;
    }

    return requiredRoles.includes(user.role);
  }
}
