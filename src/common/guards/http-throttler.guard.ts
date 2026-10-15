import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limit GLOBAL para os controllers REST.
 *
 * O `ThrottlerModule` estava registrado, mas sem nenhum `APP_GUARD`: na prática
 * o limite só existia onde alguém lembrou de pôr `@UseGuards(GqlThrottlerGuard)`
 * — auth e payments, ambos resolvers GraphQL. Todo o REST ficava SEM TETO,
 * incluindo `/n8n/*`, onde cada requisição dispara uma execução do agente (que
 * consome tokens de LLM) e carrega centenas de pedidos com relações. Um laço de
 * POSTs era DoS e fatura aberta ao mesmo tempo.
 *
 * Por que não registrar o `GqlThrottlerGuard` globalmente: como APP_GUARD ele
 * rodaria em CADA field resolver do GraphQL, e uma única query com muitos campos
 * estouraria o limite sozinha — o comentário daquele arquivo já alerta para isso.
 * Aqui o guard ignora qualquer contexto que não seja HTTP, então o GraphQL segue
 * com o throttle escopado que já tinha.
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType<string>() !== 'http') return true;
    return super.canActivate(context);
  }
}
