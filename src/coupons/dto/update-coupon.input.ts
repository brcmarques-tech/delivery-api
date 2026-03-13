import { InputType, Field, Float, Int } from '@nestjs/graphql';

@InputType()
export class UpdateCouponInput {
  @Field()
  id: string;

  @Field({ nullable: true })
  code?: string;

  @Field({ nullable: true })
  discountType?: string;

  @Field(() => Float, { nullable: true })
  discountValue?: number;

  @Field(() => Float, { nullable: true })
  minimumOrder?: number;

  @Field(() => Float, { nullable: true })
  maxDiscount?: number;

  @Field(() => Int, { nullable: true })
  maxUses?: number;

  @Field({ nullable: true })
  expiresAt?: Date;
}
