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
    if (!ctx?.req) return true; // sem req HTTP (WS/subscription) → não aplica
    return super.canActivate(context);
  }
}
