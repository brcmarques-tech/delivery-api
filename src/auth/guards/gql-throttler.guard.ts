import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * A#4/Input#1: throttler ciente do contexto GraphQL. O ThrottlerGuard padrão
 * espera req/res HTTP; num resolver GraphQL eles vêm de `GqlExecutionContext`.
 * Aplicado de forma ESCOPADA (só nas mutations de auth), não global — para não
 * contar cada field resolver contra o limite. Requisições sem req HTTP (ex.:
 * subscriptions WS) passam sem throttle.
 */
@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  getRequestResponse(context: ExecutionContext) {
    const gqlCtx = GqlExecutionContext.create(context);
    const ctx = gqlCtx.getContext();
    return { req: ctx.req, res: ctx.req?.res ?? ctx.res };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const gqlCtx = GqlExecutionContext.create(context);
    const ctx = gqlCtx.getContext();

    // A SUBSCRIPTION `sessionKicked` ESTAVA SEMPRE FALHANDO (achado em
    // 15/10/2026, lendo o console do navegador no painel do lojista).
    //
    // A guarda de escape checava só `req`, e o estouro era em `res`:
    //
    //   TypeError: Cannot read properties of undefined (reading 'header')
    //       at ThrottlerGuard.handleRequest (throttler.guard.ts:197)
    //       at async createSourceEventStream (graphql/execution/subscribe.js)
    //
    // Numa subscription por graphql-ws o contexto TEM um `req` — a requisição
    // de upgrade do WebSocket. Então `!ctx?.req` era falso, seguia para o
    // ThrottlerGuard, e lá dentro ele chama `res.header(...)` para escrever os
    // cabeçalhos de rate limit. `res` não existe num WebSocket.
    //
    // O que isso custava: `sessionKicked` é o aviso de que a conta foi
    // conectada em outro aparelho e ESTA sessão caiu. Sem ele, o aparelho
    // antigo segue mostrando uma tela que parece funcionar, até a próxima
    // requisição falhar por autenticação — e a pessoa não entende por quê.
    //
    // Só as subscriptions DESTE resolver eram afetadas: é o único com o guard
    // em nível de classe. `orderUpdated`, `orderCreated` e `deliveryUpdated`
    // não passam por aqui, então o tempo real dos pedidos nunca esteve
    // quebrado.
    //
    // A condição agora é a que o comentário do arquivo sempre descreveu: sem
    // par req/res utilizável, não há throttle a aplicar. Exigir `res` não
    // afrouxa nada em HTTP, onde ele sempre existe.
    const res = ctx?.req?.res ?? ctx?.res;
    if (!ctx?.req || !res) return true;
    return super.canActivate(context);
  }
}
