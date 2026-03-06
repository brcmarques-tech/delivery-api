import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';
import { CreateOrderInput } from './dto/create-order.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole, OrderStatus } from '../common/enums';

@Resolver(() => Order)
export class OrdersResolver {
  constructor(private ordersService: OrdersService) {}

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

  @Mutation(() => Order)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR, UserRole.ADMIN)
  updateOrderStatus(
    @Args('id') id: string,
    @Args('status', { type: () => OrderStatus }) status: OrderStatus,
  ): Promise<Order> {
    return this.ordersService.updateStatus(id, status);
  }
}
