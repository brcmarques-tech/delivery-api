import { Resolver, Query, Mutation, Args, Subscription, Int } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
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

@Resolver(() => Order)
export class OrdersResolver {
  constructor(
    private ordersService: OrdersService,
    @Inject(PUB_SUB) private pubSub: PubSub,
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
  @UseGuards(GqlAuthGuard)
  order(@Args('id') id: string): Promise<Order> {
    return this.ordersService.findById(id);
  }

  @Query(() => [Order])
  @UseGuards(GqlAuthGuard)
  myOrders(@CurrentUser() user: AppUser): Promise<Order[]> {
    return this.ordersService.findByCustomer(user.id);
  }

  @Query(() => [Order])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  storeOrders(@Args('storeId') storeId: string): Promise<Order[]> {
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
    // With Pagar.me split, payments are already distributed at transaction time
    return this.ordersService.confirmReceipt(orderId, user.id);
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
  refundOrder(
    @Args('orderId') orderId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.refundOrder(orderId, user.id);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  updateOrderStatus(
    @Args('id') id: string,
    @Args('status', { type: () => OrderStatus }) status: OrderStatus,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
    return this.ordersService.updateStatus(id, status, user);
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  adjustOrderItemWeight(
    @Args('orderItemId') orderItemId: string,
    @Args('actualWeightGrams', { type: () => Int }) actualWeightGrams: number,
  ): Promise<Order> {
    return this.ordersService.adjustItemWeight(orderItemId, actualWeightGrams);
  }

  @Subscription(() => Order, {
    filter: (payload, variables) =>
      !variables.storeId || payload.orderCreated.store?.id === variables.storeId,
  })
  orderCreated(@Args('storeId', { nullable: true }) storeId?: string) {
    return this.pubSub.asyncIterableIterator('orderCreated');
  }

  @Subscription(() => Order, {
    filter: (payload, variables) => {
      const order = payload.orderUpdated;
      if (variables.storeId && order.store?.id !== variables.storeId) return false;
      if (variables.orderId && order.id !== variables.orderId) return false;
      return true;
    },
  })
  orderUpdated(
    @Args('storeId', { nullable: true }) storeId?: string,
    @Args('orderId', { nullable: true }) orderId?: string,
  ) {
    return this.pubSub.asyncIterableIterator('orderUpdated');
  }
}
