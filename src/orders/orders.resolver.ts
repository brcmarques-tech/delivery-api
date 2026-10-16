import { Resolver, Query, Mutation, Args, Subscription, Int, ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { UseGuards, Inject, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PubSub } from 'graphql-subscriptions';
import { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';
import { DeliveryCodesService } from './delivery-codes.service';
import { CreateOrderInput } from './dto/create-order.input';
import { OrderPage } from './dto/order-page.output';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permission } from '../auth/decorators/permission.decorator';
import { AppUser } from '../users/entities/app-user.entity';
import { UserRole, OrderStatus } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

// KAN: escopo de ownership das subscriptions de pedido. O usuário autenticado do
// WebSocket chega no `context.wsUser` (validado no onConnect do GraphQLModule).
// Quem pode ver um pedido: superadmin, o dono da loja, o cliente ou o entregador
// atribuído. Fail-closed: sem wsUser ou sem a relation necessária → não emite.
function wsUserIsOrderParty(order: any, user: any): boolean {
  if (!user || !order) return false;
  if (user.role === 'SUPERADMIN') return true;
  const uid = user.sub;
  return (
    order?.customer?.id === uid ||
    order?.store?.owner?.id === uid ||
    order?.delivery?.deliverer?.id === uid
  );
}

/**
 * A evidência de uma entrega, para a plataforma decidir uma disputa.
 *
 * NENHUM CAMPO AQUI É UM CÓDIGO, e isso é a regra do tipo, não um descuido.
 * O que decide uma disputa é SE e QUANDO cada código foi registrado, com qual
 * GPS e com que motivo — nunca qual era o número. Devolver o valor abriria uma
 * rota de leitura para o segredo sem utilidade nenhuma na tela de quem decide.
 *
 * Quem for acrescentar campo aqui: datas, coordenadas, contadores e texto
 * escrito por pessoas, sim. Os seis dígitos, não.
 */
@ObjectType()
export class EvidenciaDeEntrega {
  @Field(() => ID) orderId: string;

  /** Pedido antigo (criado antes do deploy) não tem código nenhum. */
  @Field() usaCodigo: boolean;

  @Field(() => Date, { nullable: true }) codigoDaLojaEm: Date | null;
  @Field(() => Date, { nullable: true }) codigoDoEntregadorEm: Date | null;
  @Field(() => Date, { nullable: true }) codigoDoClienteEm: Date | null;

  /** Onde o entregador estava ao registrar o código da LOJA. */
  @Field(() => Float, { nullable: true }) coletaLat: number | null;
  @Field(() => Float, { nullable: true }) coletaLng: number | null;

  /** Onde ele estava ao registrar o código do CLIENTE, ou a entrega sem código. */
  @Field(() => Float, { nullable: true }) entregaLat: number | null;
  @Field(() => Float, { nullable: true }) entregaLng: number | null;

  @Field(() => Date, { nullable: true }) entregaSemCodigoEm: Date | null;
  // Tipo EXPLÍCITO. Com `string | null` o reflect-metadata entrega `Object` e
  // o Nest recusa a montar o schema — a API nem sobe. O typecheck passa liso;
  // quem denuncia é o boot.
  @Field(() => String, { nullable: true }) entregaSemCodigoMotivo: string | null;

  @Field(() => Int) janelaDeContestacaoHoras: number;
  @Field(() => Date, { nullable: true }) janelaVenceEm: Date | null;

  /**
   * Tentativas erradas acumuladas. Não prova má-fé por si só — digitar errado
   * acontece —, mas cinco tentativas num pedido contestado é um fato que quem
   * decide tem de ver.
   */
  @Field(() => Int) tentativasErradas: number;
  @Field(() => Date, { nullable: true }) bloqueadoAte: Date | null;

  /** A prova de recebimento, quando o cliente confirmou de verdade. */
  @Field(() => Date, { nullable: true }) confirmadoPeloClienteEm: Date | null;
}

@ObjectType()
class PopularProduct {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field({ nullable: true }) description: string;
  @Field(() => Float) price: number;
  @Field(() => Float, { nullable: true }) promotionalPrice: number;
  @Field({ nullable: true }) imageUrl: string;
  @Field() isAvailable: boolean;
  @Field({ nullable: true }) unit: string;
  @Field() storeId: string;
  @Field() storeName: string;
  @Field({ nullable: true }) storeLogoUrl: string;
  @Field() storeIsOpen: boolean;
  @Field({ nullable: true }) categoryId: string;
  @Field({ nullable: true }) categoryName: string;
  @Field(() => Int) totalSold: number;
}

@ObjectType()
class ReorderProduct {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field({ nullable: true }) description: string;
  @Field(() => Float) price: number;
  @Field(() => Float, { nullable: true }) promotionalPrice: number;
  @Field({ nullable: true }) imageUrl: string;
  @Field() isAvailable: boolean;
  @Field() storeId: string;
  @Field() storeName: string;
  @Field({ nullable: true }) storeLogoUrl: string;
  @Field() storeIsOpen: boolean;
  @Field() lastOrderedAt: Date;
}

@ObjectType()
class WeeklyTopStore {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field({ nullable: true }) description: string;
  @Field({ nullable: true }) logoUrl: string;
  @Field({ nullable: true }) bannerUrl: string;
  @Field() isOpen: boolean;
  @Field() freeDelivery: boolean;
  @Field(() => Float) deliveryFee: number;
  @Field({ nullable: true }) verificationLevel: string;
  @Field(() => Int) orderCount: number;
  @Field(() => Float) totalRevenue: number;
}

@ObjectType()
class FrequentStore {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field({ nullable: true }) description: string;
  @Field({ nullable: true }) logoUrl: string;
  @Field({ nullable: true }) bannerUrl: string;
  @Field() isOpen: boolean;
  @Field() freeDelivery: boolean;
  @Field(() => Float) deliveryFee: number;
  @Field({ nullable: true }) verificationLevel: string;
  @Field(() => Int) orderCount: number;
  @Field() lastOrderAt: Date;
}

@Resolver(() => Order)
export class OrdersResolver {
  constructor(
    private ordersService: OrdersService,
    @Inject(PUB_SUB) private pubSub: PubSub,
    private configService: ConfigService,
    private deliveryCodesService: DeliveryCodesService,
  ) {}

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard)
  createOrder(
    @Args('input') input: CreateOrderInput,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.create(input, user);
  }

  @Query(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  async order(
    @Args('id') id: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    const order = await this.ordersService.findById(id);
    const isSuperadmin = user.role === UserRole.SUPERADMIN;
    const isCustomer = order.customer?.id === user.id;
    const isDeliverer = order.delivery?.deliverer?.id === user.id;
    const isStoreOwner = order.store?.owner?.id === user.id;
    if (!isSuperadmin && !isCustomer && !isDeliverer && !isStoreOwner) {
      throw new BadRequestException('Você não tem permissão para ver este pedido.');
    }
    return order;
  }

  // Perf (F6): paginado. Antes descia o historico inteiro (cap 500) com itens +
  // produtos aninhados a cada abertura da aba de pedidos do app.
  @Query(() => [Order])
  @UseGuards(GqlAuthGuard)
  myOrders(
    @CurrentUser() user: AppUser,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<Order[]> {
    return this.ordersService.findByCustomer(user.id, limit, offset);
  }

  @Query(() => [PopularProduct])
  popularProducts(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 12 }) limit?: number,
  ): Promise<PopularProduct[]> {
    return this.ordersService.getPopularProducts(limit);
  }

  @Query(() => [ReorderProduct])
  @UseGuards(GqlAuthGuard)
  reorderSuggestions(
    @CurrentUser() user: AppUser,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 10 }) limit?: number,
  ): Promise<ReorderProduct[]> {
    return this.ordersService.getReorderSuggestions(user.id, limit);
  }

  @Query(() => [FrequentStore])
  @UseGuards(GqlAuthGuard)
  frequentStores(
    @CurrentUser() user: AppUser,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 6 }) limit?: number,
  ): Promise<FrequentStore[]> {
    return this.ordersService.getFrequentStores(user.id, limit);
  }

  @Query(() => [WeeklyTopStore])
  topStoresWeekly(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 5 }) limit?: number,
  ): Promise<WeeklyTopStore[]> {
    return this.ordersService.getTopStoresWeekly(limit);
  }

  @Query(() => [Order])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  async storeOrders(
    @Args('storeId') storeId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order[]> {
    const store = await this.ordersService.findStoreById(storeId);
    if (store?.owner?.id !== user.id) {
      throw new BadRequestException('Você não tem permissão para ver pedidos desta loja.');
    }
    return this.ordersService.findByStore(storeId);
  }

  @Query(() => [Order])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  availableDeliveries(): Promise<Order[]> {
    return this.ordersService.findPendingForDelivery();
  }

  // KAN-292: paginado no servidor (status/busca/limit/offset). Antes retornava a
  // tabela inteira; a tela ainda fazia polling em cima disso.
  @Query(() => OrderPage)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allOrders(
    @Args('status', { nullable: true }) status?: string,
    @Args('search', { nullable: true }) search?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<OrderPage> {
    return this.ordersService.findAllAdminPaginated(
      status ?? null,
      search ?? null,
      limit ?? 20,
      offset ?? 0,
    );
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard)
  async confirmReceipt(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.confirmReceipt(orderId, user.id);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard)
  customerDenyDelivery(
    @Args('orderId') orderId: string,
    @Args('reason') reason: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.customerDenyDelivery(orderId, user.id, reason);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard)
  disputeCompletedOrder(
    @Args('orderId') orderId: string,
    @Args('reason') reason: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.disputeCompletedOrder(orderId, user.id, reason);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  async requestCancelDispute(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    const order = await this.ordersService.findById(orderId);
    if (order.store?.owner?.id !== user.id) {
      throw new BadRequestException('Você não tem permissão para este pedido');
    }
    return this.ordersService.requestCancelDispute(orderId, user.id);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard)
  cancelDispute(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.cancelDispute(orderId, user.id);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard)
  cancelOrder(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.cancelByCustomer(orderId, user.id);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  rejectOrder(
    @Args('orderId') orderId: string,
    @Args('reason') reason: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.rejectOrder(orderId, user.id, reason);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  vendorCancelOrder(
    @Args('orderId') orderId: string,
    @Args('reason') reason: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.vendorCancelOrder(orderId, user.id, reason);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  vendorConfirmPickup(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.vendorConfirmPickup(orderId, user.id);
  }

  // ─── Garantia de entrega por CÓDIGOS ──────────────────────────────────
  //
  // LEITURA: cada parte lê SÓ o seu código, por uma query dedicada que valida
  // posse e devolve um único valor.
  //
  // Isto não é preciosismo de API: os códigos NÃO são campos do tipo `Order`
  // (ver order.entity.ts) exatamente para que nenhuma query de pedido os
  // carregue de carona. Se o código do cliente fosse campo do pedido, a query
  // do ENTREGADOR o traria — e ele é justamente o segredo que o entregador tem
  // de receber da pessoa, não de ler no próprio app. Esse erro já aconteceu
  // três vezes neste projeto com outros dados sensíveis.

  /**
   * A EVIDÊNCIA DE UMA ENTREGA, para a plataforma decidir uma disputa.
   *
   * Existe porque recuperar repasse já feito é IMPOSSÍVEL (KAN-303): a defesa
   * da plataforma num chargeback é a prova de entrega, e quem decide precisa
   * tê-la na tela. Hoje a aba de disputas do superadmin mostra só o motivo que
   * o cliente escreveu — ou seja, só um dos dois lados.
   *
   * Query DEDICADA, e não campos no tipo `Order`, por dois motivos:
   *
   *  1. o GPS do entregador e o motivo que ele escreveu são informação sobre
   *     pessoas. Posto no `Order`, qualquer um que leia o pedido os recebe —
   *     inclusive o cliente, que é a outra parte da disputa.
   *  2. é o mesmo desenho das três queries de código acima, e por consistência
   *     é mais fácil de auditar: dado sensível de entrega mora em query
   *     guardada, não em campo de pedido.
   *
   * NÃO DEVOLVE CÓDIGO NENHUM — nem para o superadmin. Ele não precisa: o que
   * decide uma disputa é SE e QUANDO cada código foi registrado, com qual GPS,
   * não qual era o número. Devolver o valor aqui criaria uma rota de leitura
   * para o segredo, e o segredo não tem utilidade nenhuma nesta tela.
   */
  @Query(() => EvidenciaDeEntrega)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async evidenciaDeEntrega(
    @Args('orderId') orderId: string,
  ): Promise<EvidenciaDeEntrega> {
    const pedido = await this.ordersService.findById(orderId);
    const horas = Math.max(
      1,
      Number(process.env.DELIVERY_NO_CODE_DISPUTE_HOURS) || 24,
    );
    const semCodigoEm = pedido.entregaSemCodigoEm;
    return {
      orderId: pedido.id,
      usaCodigo: !!pedido.codigoVendedor,
      codigoDaLojaEm: pedido.codigoVendedorUsadoEm ?? null,
      codigoDoEntregadorEm: pedido.codigoEntregadorUsadoEm ?? null,
      codigoDoClienteEm: pedido.codigoClienteUsadoEm ?? null,
      coletaLat: pedido.codigoVendedorLat ?? null,
      coletaLng: pedido.codigoVendedorLng ?? null,
      entregaLat: pedido.codigoClienteLat ?? null,
      entregaLng: pedido.codigoClienteLng ?? null,
      entregaSemCodigoEm: semCodigoEm ?? null,
      entregaSemCodigoMotivo: pedido.entregaSemCodigoMotivo ?? null,
      janelaDeContestacaoHoras: horas,
      // Quando a janela vence (ou venceu). Calculado aqui e não no cliente
      // porque a duração é de uma env var do servidor — o painel não tem como
      // saber, e chutar 24h daria data errada se alguém reconfigurar.
      janelaVenceEm: semCodigoEm
        ? new Date(semCodigoEm.getTime() + horas * 3600_000)
        : null,
      tentativasErradas: pedido.codigoTentativas ?? 0,
      bloqueadoAte: pedido.codigoBloqueadoAte ?? null,
      confirmadoPeloClienteEm: pedido.customerConfirmedAt ?? null,
    };
  }

  /** O lojista lê o código QUE O ENTREGADOR vai digitar na coleta. */
  @Query(() => String, { nullable: true })
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  codigoDaMinhaLoja(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<string | null> {
    return this.deliveryCodesService.lerCodigo(orderId, 'VENDEDOR', user.id);
  }

  /** O entregador lê o código QUE O LOJISTA vai digitar na coleta. */
  @Query(() => String, { nullable: true })
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  meuCodigoDeEntregador(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<string | null> {
    return this.deliveryCodesService.lerCodigo(orderId, 'ENTREGADOR', user.id);
  }

  /** O cliente lê o código QUE O ENTREGADOR vai digitar na porta. */
  @Query(() => String, { nullable: true })
  @UseGuards(GqlAuthGuard)
  meuCodigoDeEntrega(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<string | null> {
    return this.deliveryCodesService.lerCodigo(orderId, 'CLIENTE', user.id);
  }

  // REGISTRO: quem digita é sempre a OUTRA parte. É essa troca cruzada que faz
  // o código provar presença física — e não apenas que alguém logado tocou num
  // botão, que era toda a "prova" do fluxo anterior.

  /** Coleta: o ENTREGADOR digita o código da loja. */
  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  registrarCodigoDaLoja(
    @Args('orderId') orderId: string,
    @Args('codigo') codigo: string,
    @CurrentUser() user: AppUser,
    // O GPS do entregador no instante do registro. É a evidência que sustenta
    // a contestação de chargeback (KAN-303), onde recuperar repasse já feito é
    // impossível e a defesa é a prova de entrega.
    @Args('latitude', { type: () => Float, nullable: true }) latitude?: number,
    @Args('longitude', { type: () => Float, nullable: true }) longitude?: number,
  ): Promise<Order> {
    return this.deliveryCodesService.registrarCodigo({
      orderId,
      parte: 'VENDEDOR',
      codigo,
      digitadoPor: user.id,
      latitude,
      longitude,
    });
  }

  /** Coleta: o LOJISTA digita o código do entregador. */
  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  registrarCodigoDoEntregador(
    @Args('orderId') orderId: string,
    @Args('codigo') codigo: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.deliveryCodesService.registrarCodigo({
      orderId,
      parte: 'ENTREGADOR',
      codigo,
      digitadoPor: user.id,
    });
  }

  /**
   * Entrega sem o código do cliente (ausente, dormindo, ou que se recusa).
   *
   * Não libera dinheiro: registra a evidência e abre a janela de contestação.
   * O caminho rápido continua sendo o código — este existe para o pagamento do
   * entregador não ficar preso à boa vontade do cliente.
   */
  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  registrarEntregaSemCodigo(
    @Args('orderId') orderId: string,
    @Args('motivo') motivo: string,
    @CurrentUser() user: AppUser,
    @Args('latitude', { type: () => Float, nullable: true }) latitude?: number,
    @Args('longitude', { type: () => Float, nullable: true }) longitude?: number,
  ): Promise<Order> {
    return this.deliveryCodesService.registrarEntregaSemCodigo({
      orderId,
      delivererId: user.id,
      motivo,
      latitude,
      longitude,
    });
  }

  /** Entrega: o ENTREGADOR digita o código do cliente. LIBERA o dinheiro. */
  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  registrarCodigoDoCliente(
    @Args('orderId') orderId: string,
    @Args('codigo') codigo: string,
    @CurrentUser() user: AppUser,
    @Args('latitude', { type: () => Float, nullable: true }) latitude?: number,
    @Args('longitude', { type: () => Float, nullable: true }) longitude?: number,
  ): Promise<Order> {
    return this.deliveryCodesService.registrarCodigo({
      orderId,
      parte: 'CLIENTE',
      codigo,
      digitadoPor: user.id,
      latitude,
      longitude,
    });
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  refundOrder(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.refundOrder(orderId, user.id);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  async updateOrderStatus(
    @Args('id') id: string,
    @Args('status', { type: () => OrderStatus }) status: OrderStatus,
    @CurrentUser() user: any,
  ): Promise<Order> {
    // Verify vendor owns the store associated with this order
    const order = await this.ordersService.findById(id);
    if (order.store?.owner?.id !== user.id) {
      throw new BadRequestException('Você não tem permissão para alterar este pedido');
    }
    // BL#1 (CRÍTICO): o vendedor só pode AVANÇAR o pedido no preparo. Antes esta
    // mutation aceitava qualquer transição da tabela de estados — inclusive
    // READY→DELIVERING→DELIVERER_CONFIRMED_DELIVERY. O vendedor conseguia se
    // auto-conduzir até o ponto em que o scheduler de auto-confirmação (10min)
    // captura o cartão e paga o vendedor, SEM entregador e SEM o cliente
    // confirmar o recebimento → cobrava o cliente por mercadoria nunca entregue.
    // Estados de entregador/cliente/sistema têm mutations próprias (confirmPickup,
    // confirmReceipt, etc.) e ficam de fora daqui.
    const VENDOR_ALLOWED: OrderStatus[] = [
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
    ];

    // ...mas isso criava um beco sem saída para quem não usa entregador do app.
    // A tabela permite READY→DELIVERED, e NINGUÉM podia disparar essa transição:
    // o lojista era barrado aqui, `vendorConfirmPickup` exige entregador, o
    // agente n8n também bloqueia DELIVERED, e `confirmDelivery` exige um
    // entregador do app — que nunca vai aparecer, porque pedidos `isPickup` são
    // excluídos de `findPendingForDelivery`. Resultado: pedido de retirada pago
    // por PIX ficava em READY para SEMPRE — nunca virava COMPLETED, o
    // `settlePayment` nunca rodava e o lojista nunca recebia. Custódia eterna.
    //
    // Liberar DELIVERED aqui NÃO reabre o BL#1 do ponto de vista de "pular
    // estados": o pedido ainda passa por COMPLETED só via `confirmReceipt` ou
    // pela auto-confirmação por tempo.
    //
    // ATENÇÃO — o comentário anterior aqui dizia que "o scheduler de
    // auto-confirmação só casa DELIVERER_CONFIRMED_DELIVERY, então o lojista não
    // consegue se auto-pagar". Isso DEIXOU DE SER VERDADE quando o scheduler
    // passou a cobrir também DELIVERED (sem isso, pedido de retirada ficava
    // preso em custódia se o cliente nunca abrisse o app). Hoje o lojista marca
    // DELIVERED e, passada a janela, o repasse sai sem nenhuma ação do cliente.
    //
    // Isso é uma ESCOLHA, não um descuido: a alternativa é o dinheiro travar
    // indefinidamente. O contrapeso é a janela de disputa de 48h, e o cliente é
    // notificado no momento em que o pedido vira DELIVERED. A janela é
    // configurável por `PICKUP_AUTOCONFIRM_MINUTES` — ver o scheduler.
    const entregaPropriaOuRetirada =
      order.isPickup === true || order.store?.hasOwnDelivery === true;
    if (entregaPropriaOuRetirada) {
      VENDOR_ALLOWED.push(OrderStatus.DELIVERED);
    }

    if (!VENDOR_ALLOWED.includes(status)) {
      throw new BadRequestException('O lojista não pode definir este status do pedido.');
    }
    return this.ordersService.updateStatus(id, status, user);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('orders')
  resolveDispute(
    @Args('orderId') orderId: string,
    @Args('resolution') resolution: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.resolveDispute(orderId, resolution, user.id);
  }

  @Query(() => [Order])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  disputedOrders(): Promise<Order[]> {
    return this.ordersService.findDisputed();
  }

  /**
   * Repasses de entregador retidos na plataforma (PIX com split-on-charge).
   * Sem isto o passivo só existia como texto em `notes`.
   */
  @Query(() => [Order])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('deliveries')
  delivererPayables(
    @Args('apenasAbertos', { nullable: true, defaultValue: true })
    apenasAbertos: boolean,
  ): Promise<Order[]> {
    return this.ordersService.delivererPayables(apenasAbertos);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('deliveries')
  markDelivererPayablePaid(@Args('orderId') orderId: string): Promise<Order> {
    return this.ordersService.markDelivererPayablePaid(orderId);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  adjustOrderItemWeight(
    @Args('orderItemId') orderItemId: string,
    @Args('actualWeightGrams', { type: () => Int }) actualWeightGrams: number,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.adjustItemWeight(orderItemId, actualWeightGrams, user.id);
  }

  // DEV ONLY: simula pagamento para testes (AWAITING_PAYMENT → PENDING)
  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async simulatePayment(
    @Args('orderId') orderId: string,
  ): Promise<Order> {
    const env = this.configService.get('NODE_ENV', 'development');
    if (env === 'production') {
      throw new BadRequestException('Mutation disponivel apenas em desenvolvimento');
    }
    return this.ordersService.simulatePayment(orderId);
  }

  // KAN: ownership real por subscription. O `onConnect` do GraphQLModule valida o
  // JWT do handshake e coloca o usuário em `context.wsUser`; os filtros abaixo
  // usam isso + as relations do payload (o pedido é publicado via findById, que
  // carrega store.owner/customer/delivery.deliverer) para só entregar o evento a
  // quem é parte do pedido. Fail-closed.
  @Subscription(() => Order, {
    filter: (payload, variables, context) => {
      const order = payload.orderCreated;
      const user = context?.wsUser;
      if (!variables.storeId) return false;
      if (order?.store?.id !== variables.storeId) return false;
      // Só o dono da loja (ou superadmin) recebe os novos pedidos dela.
      if (!user) return false;
      return user.role === 'SUPERADMIN' || order?.store?.owner?.id === user.sub;
    },
  })
  orderCreated(@Args('storeId', { nullable: true }) storeId?: string) {
    if (!storeId) throw new BadRequestException('storeId é obrigatório para subscriptions');
    return this.pubSub.asyncIterableIterator('orderCreated');
  }

  @Subscription(() => Order, {
    filter: (payload, variables, context) => {
      const order = payload.orderUpdated;
      const user = context?.wsUser;
      if (!user) return false; // fail-closed: WS sem autenticação não recebe pedidos
      if (user.role === 'SUPERADMIN') return true;
      // storeId (painel do vendedor): tem que ser dono da loja
      if (variables.storeId) {
        return order?.store?.id === variables.storeId && order?.store?.owner?.id === user.sub;
      }
      // orderId (rastreio de cliente/entregador): tem que ser parte do pedido
      if (variables.orderId) {
        return order?.id === variables.orderId && wsUserIsOrderParty(order, user);
      }
      // Sem args (ex.: ping do app mobile): recebe SÓ updates de pedidos dos quais
      // é parte — antes emitia TODOS os pedidos da plataforma p/ qualquer cliente.
      return wsUserIsOrderParty(order, user);
    },
  })
  orderUpdated(
    @Args('storeId', { nullable: true }) storeId?: string,
    @Args('orderId', { nullable: true }) orderId?: string,
  ) {
    return this.pubSub.asyncIterableIterator('orderUpdated');
  }
}
