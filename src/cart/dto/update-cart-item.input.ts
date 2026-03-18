import { InputType, Field, Int } from '@nestjs/graphql';
import { IsOptional, Min } from 'class-validator';


@InputType()
export class UpdateCartItemInput {
  @Field()
  cartItemId: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  quantity?: number;

  @Field({ nullable: true })
  @IsOptional()
  notes?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  weightGrams?: number;
}
