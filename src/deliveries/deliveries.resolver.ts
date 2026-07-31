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
import { AppUser } from '../users/entities/app-user.entity';
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
    @CurrentUser() user: AppUser,
  ): Promise<Delivery> {
    return this.deliveriesService.acceptDelivery(orderId, user);
  }

  @Mutation(() => Delivery)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  confirmPickup(
    @Args('deliveryId') deliveryId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Delivery> {
    return this.deliveriesService.confirmPickup(deliveryId, user.id);
  }

  @Mutation(() => Delivery)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  async confirmDelivery(
    @Args('deliveryId') deliveryId: string,
    @CurrentUser() user: AppUser,
  ): Promise<Delivery> {
    const delivery = await this.deliveriesService.confirmDelivery(deliveryId, user.id);

    if (delivery.order?.id && delivery.deliveredAt) {
      this.gateway.emitDeliveryConfirmationRequired(
        delivery.order.id,
        delivery.deliveredAt.toISOString(),
      );
    }

    return delivery;
  }

  // Perf (F6): paginado — antes o historico completo do entregador descia inteiro.
  @Query(() => [Delivery])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  myDeliveries(
    @CurrentUser() user: AppUser,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<Delivery[]> {
    return this.deliveriesService.findByDeliverer(user.id, limit, offset);
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

  // KAN: ownership da subscription de entrega. ANTES: sem `orderId` emitia TODAS
  // as entregas (GPS do entregador em tempo real + status) pra qualquer cliente,
  // e com `orderId` não checava se o assinante era parte do pedido. Agora exige
  // autenticação (context.wsUser), exige orderId (fim do firehose) e só entrega a
  // quem é o entregador atribuído, o cliente ou o dono da loja do pedido.
  @Subscription(() => Delivery, {
    filter: (payload, variables, context) => {
      const delivery = payload.deliveryUpdated;
      const user = context?.wsUser;
      if (!user) return false;
      if (!variables.orderId) return false;
      if (delivery?.order?.id !== variables.orderId) return false;
      if (user.role === 'SUPERADMIN') return true;
      const uid = user.sub;
      return (
        delivery?.deliverer?.id === uid ||
        delivery?.order?.customer?.id === uid ||
        delivery?.order?.store?.owner?.id === uid
      );
    },
  })
  deliveryUpdated(@Args('orderId', { nullable: true }) orderId?: string) {
    return this.pubSub.asyncIterableIterator('deliveryUpdated');
  }
}
