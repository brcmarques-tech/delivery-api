import { Resolver, Query, Mutation, Args, Float } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ServiceRating } from './entities/service-rating.entity';
import { RatingsService } from './ratings.service';
import { CreateServiceRatingInput } from './dto/create-service-rating.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

@Resolver(() => ServiceRating)
export class RatingsResolver {
  constructor(private readonly ratingsService: RatingsService) {}

  @Mutation(() => ServiceRating)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  rateService(
    @Args('input') input: CreateServiceRatingInput,
    @CurrentUser() user: any,
  ): Promise<ServiceRating> {
    return this.ratingsService.rateService(input, user.id);
  }

  @Query(() => [ServiceRating])
  serviceRatings(
    @Args('storeId') storeId: string,
  ): Promise<ServiceRating[]> {
    return this.ratingsService.serviceRatings(storeId);
  }

  @Query(() => Float)
  averageStoreRating(
    @Args('storeId') storeId: string,
  ): Promise<number> {
    return this.ratingsService.averageStoreRating(storeId);
  }

  @Query(() => ServiceRating, { nullable: true })
  @UseGuards(GqlAuthGuard)
  ratingForAppointment(
    @Args('appointmentId') appointmentId: string,
  ): Promise<ServiceRating | null> {
    return this.ratingsService.ratingForAppointment(appointmentId);
  }
}
