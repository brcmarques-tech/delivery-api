import { Resolver, Query, Mutation, Args, Subscription, Int, ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { UseGuards, Inject, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PubSub } from 'graphql-subscriptions';
import { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';
import { CreateOrderInput } from './dto/create-order.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
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

  @Query(() => [Order])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allOrders(): Promise<Order[]> {
    return this.ordersService.findAllAdmin();
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
    if (!VENDOR_ALLOWED.includes(status)) {
      throw new BadRequestException('O lojista não pode definir este status do pedido.');
    }
    return this.ordersService.updateStatus(id, status, user);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
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
