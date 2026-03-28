import { InputType, Field, Float, Int } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional } from 'class-validator';

@InputType()
export class CreateServiceInput {
  @Field()
  @IsNotEmpty()
  storeId: string;

  @Field()
  @IsNotEmpty()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  price?: number;

  @Field(() => Int, { nullable: true, defaultValue: 60 })
  @IsOptional()
  estimatedDuration?: number;

  @Field({ nullable: true })
  @IsOptional()
  imageUrl?: string;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  requiresQuote?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  categoryId?: string;
}
