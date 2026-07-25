import { InputType, Field, Float } from '@nestjs/graphql';
import { IsOptional, IsNumber, IsInt, Min } from 'class-validator';

@InputType()
export class UpdateProductInput {
  @Field()
  id: string;

  @Field({ nullable: true })
  @IsOptional()
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  // Input#2: o update não tinha guarda de faixa (o create tem @Min(0)); um preço
  // negativo zerava/invertia o subtotal e a comissão dos pedidos.
  @IsNumber()
  @Min(0)
  price?: number;

  @Field({ nullable: true })
  @IsOptional()
  imageUrl?: string;

  @Field({ nullable: true })
  @IsOptional()
  unit?: string;

  @Field({ nullable: true })
  @IsOptional()
  categoryId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number;

  @Field({ nullable: true })
  @IsOptional()
  barcode?: string;

  @Field({ nullable: true })
  @IsOptional()
  isVariableWeight?: boolean;
}
