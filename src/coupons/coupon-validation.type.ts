import { ObjectType, Field, Float } from '@nestjs/graphql';

@ObjectType()
export class CouponValidation {
  @Field()
  valid: boolean;

  @Field(() => Float)
  discount: number;

  @Field()
  couponId: string;

  @Field()
  message: string;
}
