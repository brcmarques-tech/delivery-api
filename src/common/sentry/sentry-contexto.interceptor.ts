import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import * as Sentry from '@sentry/nestjs';

/**
 * KAN-202 — QUEM ERA O USUÁRIO QUANDO QUEBROU, E O QUE ELE ESTAVA PEDINDO
 *
 * Sem isto, um erro no Sentry chega como "Internal server error" numa rota
 * `/graphql` — todas as operações do sistema entram pelo mesmo endereço, então
 * a pilha é o único sinal e dois bugs diferentes viram o mesmo cartão. Com o
 * nome da operação e o usuário, dá para responder as duas perguntas que
 * importam no suporte: "quantos clientes isto atingiu" e "este cliente
 * específico passou por aqui".
 *
 * PRIVACIDADE: vai o id, o papel e o e-mail — e-mail porque é como o suporte
 * acha a pessoa, e o Sentry é ferramenta interna. NÃO vão CPF, telefone,
 * endereço nem qualquer coisa do pagamento: isso não ajuda a depurar e seria
 * dado sensível saindo da nossa infra.
 */
@Injectable()
export class SentryContextoInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const gql = GqlExecutionContext.create(context);
    const req = gql.getContext()?.req;
    const info = gql.getInfo?.();

    const usuario = req?.user;
    if (usuario?.id) {
      Sentry.setUser({
        id: usuario.id,
        email: usuario.email,
        // `role` distingue cliente, entregador, lojista e superadmin — a
        // primeira pergunta diante de um erro é "quem viu isto".
        role: usuario.role,
      });
    } else {
      // Operação pública (vitrine, login). Limpar é importante: o scope do
      // Sentry é reaproveitado entre requisições, e sem isso um erro de
      // visitante anônimo sairia carimbado com o último usuário logado.
      Sentry.setUser(null);
    }

    if (info?.fieldName) {
      // Nome da operação GraphQL como tag: é o que separa "createOrder
      // quebrou" de "publicStorefront quebrou" quando a rota é sempre a mesma.
      Sentry.setTag('graphql.operacao', info.fieldName);
      Sentry.setTag('graphql.tipo', info.parentType?.name);
    }

    return next.handle();
  }
}
