import { Resolver, Query, Mutation, Args, Float } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformConfigService } from './platform-config.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';

@Resolver(() => PlatformConfig)
export class PlatformConfigResolver {
  constructor(private configService: PlatformConfigService) {}

  @Query(() => Float)
  promoPricePerDay(): Promise<number> {
    return this.configService.getPromoPricePerDay();
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  setPromoPricePerDay(@Args('price', { type: () => Float }) price: number): Promise<PlatformConfig> {
    return this.configService.set('promo_price_per_day', String(price));
  }

  @Query(() => Float)
  deliveryPricePerKm(): Promise<number> {
    return this.configService.getDeliveryPricePerKm();
  }

  @Query(() => Float)
  deliveryBasePrice(): Promise<number> {
    return this.configService.getDeliveryBasePrice();
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  setDeliveryPricePerKm(@Args('price', { type: () => Float }) price: number): Promise<PlatformConfig> {
    return this.configService.set('delivery_price_per_km', String(price));
  }

  @Mutation(() => PlatformConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  setDeliveryBasePrice(@Args('price', { type: () => Float }) price: number): Promise<PlatformConfig> {
    return this.configService.set('delivery_base_price', String(price));
  }

  @Query(() => [PlatformConfig])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  platformConfigs(): Promise<PlatformConfig[]> {
    return this.configService.getAll();
  }
}
