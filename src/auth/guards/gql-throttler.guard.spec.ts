import { ExecutionContext } from '@nestjs/common';
import { GqlThrottlerGuard } from './gql-throttler.guard';

/**
 * O THROTTLER E AS SUBSCRIPTIONS.
 *
 * Este guard quebrava TODA subscription do resolver em que está aplicado. A
 * guarda de escape checava `req` e o estouro era em `res`:
 *
 *   TypeError: Cannot read properties of undefined (reading 'header')
 *       at ThrottlerGuard.handleRequest (throttler.guard.ts:197)
 *
 * Numa subscription por graphql-ws existe um `req` (o upgrade do WebSocket) mas
 * não existe `res`. O ThrottlerGuard escreve os cabeçalhos de rate limit no
 * `res`, e ali não havia onde escrever.
 *
 * Os testes abaixo cobrem as duas direções, porque as duas doem:
 *
 *  - sem `res` tem de PASSAR, senão a subscription morre (era o bug);
 *  - com req/res de HTTP tem de DELEGAR ao ThrottlerGuard, senão o limite de
 *    tentativas de login deixa de existir — e afrouxar isso é pior que o bug
 *    que o conserto resolveu.
 */
describe('GqlThrottlerGuard — subscriptions não têm `res`', () => {
  let guard: GqlThrottlerGuard;

  beforeEach(() => {
    // O guard real precisa de opções, storage e reflector. Nenhum teste aqui
    // exercita o miolo do ThrottlerGuard — só o desvio antes dele — então os
    // três podem ser mínimos.
    guard = new GqlThrottlerGuard(
      { throttlers: [{ limit: 5, ttl: 60000 }] } as any,
      {} as any,
      {} as any,
    );
  });

  /** Um ExecutionContext de GraphQL com o contexto que eu quiser. */
  function contextoGraphQL(ctx: any): ExecutionContext {
    return {
      getType: () => 'graphql',
      getClass: () => class {},
      getHandler: () => () => {},
      getArgs: () => [undefined, {}, ctx, { fieldName: 'qualquer' }],
      getArgByIndex: (i: number) => [undefined, {}, ctx, {}][i],
      switchToHttp: () => ({}) as any,
      switchToRpc: () => ({}) as any,
      switchToWs: () => ({}) as any,
    } as unknown as ExecutionContext;
  }

  it('PASSA quando ha req de upgrade mas nenhum res (graphql-ws)', async () => {
    // Exatamente a forma que vinha do graphql-ws: req presente, res ausente.
    // Antes do conserto isto chegava ao ThrottlerGuard e lancava.
    const ctx = { req: { headers: { upgrade: 'websocket' } } };
    await expect(guard.canActivate(contextoGraphQL(ctx))).resolves.toBe(true);
  });

  it('PASSA quando nao ha req nenhum', async () => {
    await expect(guard.canActivate(contextoGraphQL({}))).resolves.toBe(true);
  });

  it('PASSA quando o contexto inteiro e nulo', async () => {
    await expect(guard.canActivate(contextoGraphQL(null))).resolves.toBe(true);
  });

  it('DELEGA ao ThrottlerGuard quando ha req E res (HTTP de verdade)', async () => {
    // O teste que impede o conserto de virar "throttle desligado". Se alguem
    // alargar a condicao de escape, isto falha.
    const chamouSuper = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockResolvedValue(true as any);

    const res = { header: jest.fn() };
    const ctx = { req: { res, headers: {}, ip: '1.2.3.4' } };
    await expect(guard.canActivate(contextoGraphQL(ctx))).resolves.toBe(true);
    expect(chamouSuper).toHaveBeenCalledTimes(1);

    chamouSuper.mockRestore();
  });

  it('DELEGA tambem quando o res vem solto no contexto, nao dentro do req', async () => {
    const chamouSuper = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockResolvedValue(true as any);

    const ctx = { req: { headers: {} }, res: { header: jest.fn() } };
    await guard.canActivate(contextoGraphQL(ctx));
    expect(chamouSuper).toHaveBeenCalledTimes(1);

    chamouSuper.mockRestore();
  });

  describe('getRequestResponse', () => {
    it('prefere o res de dentro do req', () => {
      const doReq = { header: jest.fn() };
      const solto = { header: jest.fn() };
      const r = guard.getRequestResponse(
        contextoGraphQL({ req: { res: doReq }, res: solto }),
      );
      expect(r.res).toBe(doReq);
    });

    it('cai no res solto quando o req nao tem', () => {
      const solto = { header: jest.fn() };
      const r = guard.getRequestResponse(contextoGraphQL({ req: {}, res: solto }));
      expect(r.res).toBe(solto);
    });
  });
});
