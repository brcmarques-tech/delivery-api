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

  @Query(() => [Order])
  @UseGuards(GqlAuthGuard)
  myOrders(@CurrentUser() user: AppUser): Promise<Order[]> {
    return this.ordersService.findByCustomer(user.id);
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

  // H3: LIMITATION — These subscriptions filter by storeId but don't verify the subscriber
  // actually owns the store (IDOR risk). GraphQL subscriptions in NestJS don't easily support
  // guards in the filter function. The storeId filter prevents cross-store data leakage, but
  // any authenticated user who knows a storeId could subscribe to its events.
  // TODO: Implement WebSocket auth middleware to verify store ownership on subscription init.
  // This requires custom ConnectionParams handling in the GraphQL gateway configuration.
  @Subscription(() => Order, {
    filter: (payload, variables) => {
      // Require storeId to prevent unauthorized data access
      if (!variables.storeId) return false;
      return payload.orderCreated.store?.id === variables.storeId;
    },
  })
  orderCreated(@Args('storeId', { nullable: true }) storeId?: string) {
    if (!storeId) throw new BadRequestException('storeId é obrigatório para subscriptions');
    return this.pubSub.asyncIterableIterator('orderCreated');
  }

  @Subscription(() => Order, {
    filter: (payload, variables) => {
      // Require storeId to prevent unauthorized data access
      if (!variables.storeId) return false;
      const order = payload.orderUpdated;
      if (order.store?.id !== variables.storeId) return false;
      if (variables.orderId && order.id !== variables.orderId) return false;
      return true;
    },
  })
  orderUpdated(
    @Args('storeId', { nullable: true }) storeId?: string,
    @Args('orderId', { nullable: true }) orderId?: string,
  ) {
    if (!storeId) throw new BadRequestException('storeId é obrigatório para subscriptions');
    return this.pubSub.asyncIterableIterator('orderUpdated');
  }
}
