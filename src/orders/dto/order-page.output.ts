import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Order } from '../entities/order.entity';

/**
 * KAN-292: pagina de pedidos para o painel admin. Antes `allOrders` carregava a
 * tabela INTEIRA de pedidos com 6 relations (customer, store, items,
 * items.product, delivery, delivery.deliverer) e ainda com polling — em escala,
 * query lenta -> timeout/OOM. Agora o servidor filtra (status/busca) e pagina.
 */
@ObjectType()
export class OrderPage {
  @Field(() => [Order])
  items: Order[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}
