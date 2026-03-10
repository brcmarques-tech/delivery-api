import { Resolver, Query, Mutation, Args, Float, ResolveField, Parent, Subscription } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { Store } from './entities/store.entity';
import { StoresService } from './stores.service';
import { CreateStoreInput } from './dto/create-store.input';
import { UpdateStoreInput } from './dto/update-store.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums';
import { PlatformConfigService } from '../config/platform-config.service';
import { DelivererTrackerService } from '../deliveries/deliverer-tracker.service';
import {
  VEHICLE_AVG_SPEEDS_KMH,
  DEFAULT_AVG_SPEED_KMH,
  PREPARATION_TIME_MINUTES,
  ROAD_FACTOR,
} from '../common/delivery-constants';
import { PUB_SUB } from '../pubsub/pubsub.module';

@Resolver(() => Store)
export class StoresResolver {
  constructor(
    private storesService: StoresService,
    private platformConfigService: PlatformConfigService,
    private delivererTracker: DelivererTrackerService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createStore(
    @Args('input') input: CreateStoreInput,
    @CurrentUser() user: User,
  ): Promise<Store> {
    return this.storesService.create(input, user);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  updateStore(
    @Args('input') input: UpdateStoreInput,
    @CurrentUser() user: User,
  ): Promise<Store> {
    return this.storesService.update(input, user);
  }

  @Query(() => [Store])
  stores(): Promise<Store[]> {
    return this.storesService.findAll();
  }

  @Query(() => Store)
  store(@Args('id') id: string): Promise<Store> {
    return this.storesService.findById(id);
  }

  @Query(() => [Store])
  nearbyStores(
    @Args('latitude', { type: () => Float }) lat: number,
    @Args('longitude', { type: () => Float }) lng: number,
    @Args('radiusKm', { type: () => Float, nullable: true }) radius?: number,
  ): Promise<Store[]> {
    return this.storesService.findNearby(lat, lng, radius);
  }

  @Query(() => [Store])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  myStores(@CurrentUser() user: User): Promise<Store[]> {
    return this.storesService.findByOwner(user.id);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  toggleStoreOpen(
    @Args('id') id: string,
    @CurrentUser() user: User,
  ): Promise<Store> {
    return this.storesService.toggleOpen(id, user);
  }

  @Query(() => [Store])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allStores(): Promise<Store[]> {
    return this.storesService.findAllAdmin();
  }

  @Query(() => Float)
  async calculateDeliveryFee(
    @Args('storeId') storeId: string,
    @Args('customerLatitude', { type: () => Float }) customerLat: number,
    @Args('customerLongitude', { type: () => Float }) customerLng: number,
  ): Promise<number> {
    const store = await this.storesService.findById(storeId);
    const pricePerKm = await this.platformConfigService.getDeliveryPricePerKm();
    const basePrice = await this.platformConfigService.getDeliveryBasePrice();

    // Haversine formula
    const R = 6371;
    const dLat = (customerLat - Number(store.latitude)) * Math.PI / 180;
    const dLng = (customerLng - Number(store.longitude)) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(Number(store.latitude) * Math.PI / 180) *
        Math.cos(customerLat * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceKm = R * c;

    const fee = basePrice + distanceKm * pricePerKm;
    return Math.round(fee * 100) / 100;
  }

  @Query(() => Float)
  async estimatedDeliveryTime(
    @Args('storeId') storeId: string,
    @Args('customerLatitude', { type: () => Float }) customerLat: number,
    @Args('customerLongitude', { type: () => Float }) customerLng: number,
  ): Promise<number> {
    const store = await this.storesService.findById(storeId);

    // Stores with own delivery use their static estimate
    if (store.hasOwnDelivery) {
      return store.estimatedDeliveryMinutes || 30;
    }

    const storeLat = Number(store.latitude);
    const storeLng = Number(store.longitude);

    // Store → Customer distance (haversine)
    const R = 6371;
    const dLat1 = (customerLat - storeLat) * Math.PI / 180;
    const dLng1 = (customerLng - storeLng) * Math.PI / 180;
    const a1 =
      Math.sin(dLat1 / 2) * Math.sin(dLat1 / 2) +
      Math.cos(storeLat * Math.PI / 180) *
        Math.cos(customerLat * Math.PI / 180) *
        Math.sin(dLng1 / 2) * Math.sin(dLng1 / 2);
    const storeToCustomerKm = R * 2 * Math.atan2(Math.sqrt(a1), Math.sqrt(1 - a1));

    // Try to get nearest deliverer info
    const nearest = this.delivererTracker.getNearestDelivererInfo(storeLat, storeLng);
    const delivererToStoreKm = nearest ? nearest.distanceKm : 3; // default 3km if no one online
    const vehicleType = nearest ? nearest.vehicleType : 'MOTO';
    const speed = VEHICLE_AVG_SPEEDS_KMH[vehicleType] || DEFAULT_AVG_SPEED_KMH;

    const totalDistanceKm = (delivererToStoreKm + storeToCustomerKm) * ROAD_FACTOR;
    const travelMinutes = (totalDistanceKm / speed) * 60;
    const totalMinutes = travelMinutes + PREPARATION_TIME_MINUTES;

    return Math.ceil(totalMinutes);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  toggleStoreActive(@Args('id') id: string): Promise<Store> {
    return this.storesService.toggleActive(id);
  }

  @ResolveField(() => Boolean)
  ownerMpConnected(@Parent() store: Store): boolean {
    return store.owner?.mpConnected ?? false;
  }

  @Subscription(() => Store, {
    filter: (payload, variables) =>
      !variables.storeId || payload.storeUpdated.id === variables.storeId,
  })
  storeUpdated(@Args('storeId', { nullable: true }) storeId?: string) {
    return this.pubSub.asyncIterableIterator('storeUpdated');
  }
}
