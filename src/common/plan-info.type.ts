import { ObjectType, Field, Float, Int } from '@nestjs/graphql';
import { VendorPlan } from './enums';

@ObjectType()
export class PlanInfo {
  @Field(() => VendorPlan)
  plan: VendorPlan;

  @Field(() => Int)
  maxStores: number;

  @Field(() => Float)
  commissionPercent: number;

  @Field(() => Float)
  monthlyPrice: number;

  @Field(() => Float)
  quarterlyPrice: number;

  @Field(() => Float)
  semiannualPrice: number;

  @Field(() => Float)
  annualPrice: number;

  @Field(() => Int)
  freePromosPerWeek: number;

  @Field(() => Int)
  maxProductsPerStore: number;

  @Field(() => Int)
  maxEmailsPerMonth: number;

  @Field(() => Int)
  listingPriority: number;

  @Field(() => Int)
  highlightDaysPerMonth: number;

  @Field()
  canUseCoupons: boolean;

  @Field()
  hasAnalytics: boolean;

  @Field()
  supportLevel: string;

  @Field()
  isContactSales: boolean;
}
