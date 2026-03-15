import { Resolver, Query, Mutation, Args, Float, ResolveField, Parent, Subscription } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { Store } from './entities/store.entity';
import { StoresService } from './stores.service';
import { VerificationService } from './verification.service';
import { CreateStoreInput } from './dto/create-store.input';
import { UpdateStoreInput } from './dto/update-store.input';
import { MailService } from '../mail/mail.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { UserRole, VerificationLevel } from '../common/enums';
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
    private verificationService: VerificationService,
    private platformConfigService: PlatformConfigService,
    private mailService: MailService,
    private delivererTracker: DelivererTrackerService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createStore(
    @Args('input') input: CreateStoreInput,
    @CurrentUser() user: VendorUser,
  ): Promise<Store> {
    return this.storesService.create(input, user);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  updateStore(
    @Args('input') input: UpdateStoreInput,
    @CurrentUser() user: VendorUser,
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
  myStores(@CurrentUser() user: VendorUser): Promise<Store[]> {
    return this.storesService.findByOwner(user.id);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  toggleStoreOpen(
    @Args('id') id: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Store> {
    return this.storesService.toggleOpen(id, user);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  requestVendorStoreDelete(
    @Args('storeId') storeId: string,
    @Args('password') password: string,
    @CurrentUser() user: VendorUser,
  ): Promise<boolean> {
    return this.storesService.requestVendorStoreDelete(storeId, user.id, password);
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

    if (store.hasOwnDelivery) {
      return store.estimatedDeliveryMinutes || 30;
    }

    const storeLat = Number(store.latitude);
    const storeLng = Number(store.longitude);

    const R = 6371;
    const dLat1 = (customerLat - storeLat) * Math.PI / 180;
    const dLng1 = (customerLng - storeLng) * Math.PI / 180;
    const a1 =
      Math.sin(dLat1 / 2) * Math.sin(dLat1 / 2) +
      Math.cos(storeLat * Math.PI / 180) *
        Math.cos(customerLat * Math.PI / 180) *
        Math.sin(dLng1 / 2) * Math.sin(dLng1 / 2);
    const storeToCustomerKm = R * 2 * Math.atan2(Math.sqrt(a1), Math.sqrt(1 - a1));

    const nearest = this.delivererTracker.getNearestDelivererInfo(storeLat, storeLng);
    const delivererToStoreKm = nearest ? nearest.distanceKm : 3;
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
  async toggleStoreActive(@Args('id') id: string, @CurrentUser() admin: any): Promise<Store> {
    const result = await this.storesService.toggleActive(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, `Loja ${result.isActive ? 'ativada' : 'desativada'}`, `Loja: ${result.name} (ID: ${result.id})`).catch(() => {});
    return result;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  requestStoreDelete(
    @Args('storeId') storeId: string,
    @Args('password') password: string,
    @CurrentUser() user: any,
  ): Promise<boolean> {
    return this.storesService.requestStoreDelete(storeId, user.id, password);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  recalculateVerification(@Args('storeId') storeId: string): Promise<Store> {
    return this.verificationService.recalculateScore(storeId);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  claimBadgeReward(
    @Args('storeId') storeId: string,
    @Args('level') level: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Store> {
    return this.verificationService.claimBadgeReward(storeId, level, user.id);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async setStoreVerification(
    @Args('storeId') storeId: string,
    @Args('level', { type: () => VerificationLevel }) level: VerificationLevel,
    @CurrentUser() admin: any,
    @Args('score', { type: () => Float, nullable: true }) score?: number,
  ): Promise<Store> {
    const store = await this.storesService.findById(storeId);
    store.verificationLevel = level;
    if (score !== undefined && score !== null) {
      store.verificationScore = score;
    }
    const result = await this.storesService.saveStore(store);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Verificacao de loja alterada', `Loja: ${store.name}\nNivel: ${level}${score !== undefined ? `\nScore: ${score}` : ''}`).catch(() => {});
    return result;
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
