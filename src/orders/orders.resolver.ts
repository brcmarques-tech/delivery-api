import { Resolver, Query, Mutation, Args, Subscription } from '@nestjs/graphql';
import { UseGuards, Inject, forwardRef } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { CreateOrderInput } from './dto/create-order.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole, OrderStatus } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

@Resolver(() => Order)
export class OrdersResolver {
  constructor(
    private ordersService: OrdersService,
    @Inject(forwardRef(() => DeliveriesService))
    private deliveriesService: DeliveriesService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard)
  createOrder(
    @Args('input') input: CreateOrderInput,
    @CurrentUser() user: User,
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
  myOrders(@CurrentUser() user: User): Promise<Order[]> {
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
    @CurrentUser() user: User,
  ): Promise<Order> {
    const order = await this.ordersService.confirmReceipt(orderId, user.id);

    // Trigger deliverer payout after customer confirmation
    if (order.delivery?.id) {
      this.deliveriesService
        .processDelivererPayout(order.delivery.id)
        .catch((err) => console.error('Payout after confirmation failed:', err));
    }

    return order;
  }

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  updateOrderStatus(
    @Args('id') id: string,
    @Args('status', { type: () => OrderStatus }) status: OrderStatus,
    @CurrentUser() user: User,
  ): Promise<Order> {
    return this.ordersService.updateStatus(id, status, user);
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
