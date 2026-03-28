import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Schedule } from './entities/schedule.entity';
import { SchedulesService } from './schedules.service';
import { SetScheduleInput } from './dto/set-schedule.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../common/enums';

@Resolver(() => Schedule)
export class SchedulesResolver {
  constructor(private schedulesService: SchedulesService) {}

  @Mutation(() => [Schedule])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  setSchedule(
    @Args('input') input: SetScheduleInput,
    @CurrentUser() user: any,
  ): Promise<Schedule[]> {
    return this.schedulesService.setSchedule(input, user);
  }

  @Query(() => [Schedule])
  storeSchedule(@Args('storeId') storeId: string): Promise<Schedule[]> {
    return this.schedulesService.getByStore(storeId);
  }
}
