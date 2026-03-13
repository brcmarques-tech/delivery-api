import { InputType, Field, Float, Int } from '@nestjs/graphql';

@InputType()
export class CreateCouponInput {
  @Field()
  code: string;

  @Field({ defaultValue: 'PERCENT' })
  discountType: string;

  @Field(() => Float)
  discountValue: number;

  @Field(() => Float, { nullable: true })
  minimumOrder?: number;

  @Field(() => Float, { nullable: true })
  maxDiscount?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  maxUses?: number;

  @Field({ nullable: true })
  expiresAt?: Date;

  @Field()
  storeId: string;
}
