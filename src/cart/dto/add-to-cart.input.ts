import { InputType, Field, Int } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, Min } from 'class-validator';


@InputType()
export class AddToCartInput {
  @Field()
  @IsNotEmpty()
  productId: string;

  @Field(() => Int, { defaultValue: 1 })
  @Min(1)
  quantity: number;

  @Field({ nullable: true })
  @IsOptional()
  notes?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  weightGrams?: number;
}
