import { ObjectType, Field, Float, Int } from '@nestjs/graphql';
import { VendorPlan } from './enums';

@ObjectType()
export class PlanInfo {
  @Field(() => VendorPlan)
  plan: VendorPlan;

  @Field(() => Int)
  maxStores: number;

  @Field(() => Float)
  commissionRate: number;

  @Field(() => Float)
  platformDeliveryFee: number;

  @Field()
  canPromote: boolean;

  @Field(() => Float)
  monthlyPrice: number;
}
