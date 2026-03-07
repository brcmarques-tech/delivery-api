import { InputType, Field, Float } from '@nestjs/graphql';
import { IsOptional } from 'class-validator';

@InputType()
export class CreatePromotionInput {
  @Field()
  title: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  imageUrl?: string;

  @Field()
  startDate: Date;

  @Field()
  endDate: Date;

  @Field(() => Float)
  promotionalPrice: number;

  @Field()
  storeId: string;

  @Field({ nullable: true })
  @IsOptional()
  productId?: string;
}
