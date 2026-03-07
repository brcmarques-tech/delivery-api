import { Resolver, Query, Mutation, Args, Float } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Store } from './entities/store.entity';
import { StoresService } from './stores.service';
import { CreateStoreInput } from './dto/create-store.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums';

@Resolver(() => Store)
export class StoresResolver {
  constructor(private storesService: StoresService) {}

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR, UserRole.ADMIN)
  createStore(
    @Args('input') input: CreateStoreInput,
    @CurrentUser() user: User,
  ): Promise<Store> {
    return this.storesService.create(input, user);
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

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  toggleStoreActive(@Args('id') id: string): Promise<Store> {
    return this.storesService.toggleActive(id);
  }
}
