import { Resolver, Mutation, Query, Args, Float, Int, Subscription } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { Delivery } from './entities/delivery.entity';
import { DeliveriesService } from './deliveries.service';
import { DelivererTrackerService } from './deliverer-tracker.service';
import { DeliveriesGateway } from './deliveries.gateway';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

@Resolver(() => Delivery)
export class DeliveriesResolver {
  constructor(
    private deliveriesService: DeliveriesService,
    private delivererTracker: DelivererTrackerService,
    private gateway: DeliveriesGateway,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

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
  async confirmDelivery(@Args('deliveryId') deliveryId: string): Promise<Delivery> {
    const delivery = await this.deliveriesService.confirmDelivery(deliveryId);

    // Notify customer to confirm receipt (10-min timer)
    if (delivery.order?.id && delivery.deliveredAt) {
      this.gateway.emitDeliveryConfirmationRequired(
        delivery.order.id,
        delivery.deliveredAt.toISOString(),
      );
    }

    return delivery;
  }

  @Query(() => [Delivery])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  myDeliveries(@CurrentUser() user: User): Promise<Delivery[]> {
    return this.deliveriesService.findByDeliverer(user.id);
  }

  @Query(() => [Delivery])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allDeliveries(): Promise<Delivery[]> {
    return this.deliveriesService.findAllAdmin();
  }

  @Query(() => Int)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  onlineDeliverersCount(): number {
    return this.delivererTracker.getOnlineCount();
  }

  @Subscription(() => Delivery, {
    filter: (payload, variables) =>
      !variables.orderId || payload.deliveryUpdated.order?.id === variables.orderId,
  })
  deliveryUpdated(@Args('orderId', { nullable: true }) orderId?: string) {
    return this.pubSub.asyncIterableIterator('deliveryUpdated');
  }
}
