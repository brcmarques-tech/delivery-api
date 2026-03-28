import { InputType, Field, Int } from '@nestjs/graphql';
import { IsNotEmpty } from 'class-validator';

@InputType()
export class ScheduleEntryInput {
  @Field(() => Int)
  dayOfWeek: number;

  @Field()
  startTime: string;

  @Field()
  endTime: string;

  @Field({ defaultValue: true })
  isActive: boolean;
}

@InputType()
export class SetScheduleInput {
  @Field()
  @IsNotEmpty()
  storeId: string;

  @Field(() => [ScheduleEntryInput])
  entries: ScheduleEntryInput[];
}
