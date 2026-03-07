import { InputType, Field, Float } from '@nestjs/graphql';

@InputType()
export class CreatePromotionInput {
  @Field()
  title: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  imageUrl?: string;

  @Field()
  startDate: Date;

  @Field()
  endDate: Date;

  @Field(() => Float)
  price: number;

  @Field()
  storeId: string;
}
