import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Service } from './entities/service.entity';
import { ServicesService } from './services.service';
import { CreateServiceInput } from './dto/create-service.input';
import { UpdateServiceInput } from './dto/update-service.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../common/enums';

@Resolver(() => Service)
export class ServicesResolver {
  constructor(private servicesService: ServicesService) {}

  @Mutation(() => Service)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createService(
    @Args('input') input: CreateServiceInput,
    @CurrentUser() user: any,
  ): Promise<Service> {
    return this.servicesService.create(input, user);
  }

  @Mutation(() => Service)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  updateService(
    @Args('input') input: UpdateServiceInput,
    @CurrentUser() user: any,
  ): Promise<Service> {
    return this.servicesService.update(input, user);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  deleteService(
    @Args('id') id: string,
    @CurrentUser() user: any,
  ): Promise<boolean> {
    return this.servicesService.delete(id, user);
  }

  @Query(() => [Service])
  servicesByStore(@Args('storeId') storeId: string): Promise<Service[]> {
    return this.servicesService.findByStore(storeId, false);
  }

  @Query(() => [Service])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  allServicesByStore(
    @Args('storeId') storeId: string,
    @CurrentUser() user: any,
  ): Promise<Service[]> {
    return this.servicesService.findByStore(storeId, true, user.id);
  }

  @Query(() => Service)
  service(@Args('id') id: string): Promise<Service> {
    return this.servicesService.findById(id);
  }

  @Query(() => [Service])
  searchServices(
    @Args('query') query: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
  ): Promise<Service[]> {
    return this.servicesService.searchPublic(query, limit);
  }
}
