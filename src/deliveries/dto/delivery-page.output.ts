import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Delivery } from '../entities/delivery.entity';

/**
 * KAN-292: pagina de entregas para o painel admin. Antes `allDeliveries`
 * carregava a tabela inteira com relations (order, order.store, order.customer,
 * deliverer) e ainda sob polling.
 */
@ObjectType()
export class DeliveryPage {
  @Field(() => [Delivery])
  items: Delivery[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}

/** Contagens globais para os cards de resumo (independem do filtro/pagina). */
@ObjectType()
export class DeliveryCounts {
  @Field(() => Int)
  total: number;

  @Field(() => Int)
  active: number;

  @Field(() => Int)
  completed: number;
}
