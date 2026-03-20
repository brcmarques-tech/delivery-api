import { ObjectType, Field, Float } from '@nestjs/graphql';

@ObjectType()
export class RecipientBalance {
  @Field(() => Float)
  availableAmount: number;

  @Field(() => Float)
  waitingFundsAmount: number;

  @Field(() => Float)
  transferredAmount: number;

  @Field()
  autoAnticipationEnabled: boolean;
}

@ObjectType()
export class AnticipationSimulation {
  @Field(() => Float)
  originalAmount: number;

  @Field(() => Float)
  anticipatedAmount: number;

  @Field(() => Float)
  fee: number;

  @Field(() => Float)
  feePercentage: number;
}

@ObjectType()
export class AnticipationResult {
  @Field()
  id: string;

  @Field()
  status: string;

  @Field(() => Float)
  requestedAmount: number;

  @Field(() => Float)
  approvedAmount: number;

  @Field(() => Float)
  fee: number;

  @Field()
  createdAt: string;
}
