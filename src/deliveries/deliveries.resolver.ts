import { Resolver, Mutation, Query, Args, Float } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Delivery } from './entities/delivery.entity';
import { DeliveriesService } from './deliveries.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums';

@Resolver(() => Delivery)
export class DeliveriesResolver {
  constructor(private deliveriesService: DeliveriesService) {}

  @Mutation(() => Delivery)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  acceptDelivery(
    @Args('orderId') orderId: string,
    @CurrentUser() user: User,
  ): Promise<Delivery> {
    return this.deliveriesService.acceptDelivery(orderId, user);
  }

  @Mutation(() => Delivery)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  confirmPickup(@Args('deliveryId') deliveryId: string): Promise<Delivery> {
    return this.deliveriesService.confirmPickup(deliveryId);
  }

  @Mutation(() => Delivery)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  confirmDelivery(@Args('deliveryId') deliveryId: string): Promise<Delivery> {
    return this.deliveriesService.confirmDelivery(deliveryId);
  }

  @Query(() => [Delivery])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  myDeliveries(@CurrentUser() user: User): Promise<Delivery[]> {
    return this.deliveriesService.findByDeliverer(user.id);
  }
}
