import { Resolver, Query, Mutation, Args, Subscription, Int, ObjectType, Field, ID, Float } from '@nestjs/graphql';
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
  updateOrderStatus(
    @Args('id') id: string,
    @Args('status', { type: () => OrderStatus }) status: OrderStatus,
    @CurrentUser() user: AppUser,
  ): Promise<Order> {
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
