import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GqlExecutionContext } from '@nestjs/graphql';

@Injectable()
export class GqlAuthGuard extends AuthGuard('jwt') {
  /**
   * Sobre WebSocket, `ctx.req` e o IncomingMessage do UPGRADE HTTP, que nao
   * carrega header Authorization — o app manda o token em `connectionParams`. A
   * JwtStrategy extrai de `fromAuthHeaderAsBearerToken()`, entao o guard
   * procurava o token num lugar onde ele nunca esta: TODA subscription com
   * @UseGuards(GqlAuthGuard) falhava a autenticacao e nunca entregava evento.
   *
   * O efeito mais caro era em `productUpdated`: o lojista mudava preco ou
   * estoque, o app nunca recebia a correcao do cache, e o cliente fechava o
   * pedido com o preco antigo. `storeUpdated` (loja fecha e continua aparecendo
   * aberta) e `promotionUpdated` tinham o mesmo problema.
   *
   * Devolvemos uma request sintetica com o token guardado no onConnect, para a
   * mesma JwtStrategy rodar — isActive e sessionToken seguem sendo validados,
   * nada foi afrouxado.
   */
  getRequest(context: ExecutionContext) {
    const ctx = GqlExecutionContext.create(context);
    const gqlCtx = ctx.getContext();
    if (gqlCtx?.req?.headers?.authorization) return gqlCtx.req;
    if (gqlCtx?.wsToken) {
      return {
        ...(gqlCtx.req || {}),
        headers: {
          ...(gqlCtx.req?.headers || {}),
          authorization: `Bearer ${gqlCtx.wsToken}`,
        },
      };
    }
    return gqlCtx?.req;
  }
}
