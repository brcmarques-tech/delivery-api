import { InputType, Field, Float } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional } from 'class-validator';

@InputType()
export class CreateProductInput {
  @Field()
  @IsNotEmpty()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  @Field(() => Float)
  price: number;

  @Field({ nullable: true })
  @IsOptional()
  imageUrl?: string;

  @Field({ nullable: true })
  @IsOptional()
  unit?: string;

  @Field()
  storeId: string;

  @Field({ nullable: true })
  @IsOptional()
  categoryId?: string;

  @Field({ nullable: true, defaultValue: 0 })
  @IsOptional()
  stock?: number;
}
