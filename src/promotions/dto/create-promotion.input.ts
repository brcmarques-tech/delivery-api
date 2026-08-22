import { InputType, Field, Float } from '@nestjs/graphql';
import { IsOptional, IsNumber, Min } from 'class-validator';

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

  // Input#3: sem validação, um promotionalPrice negativo virava o preço efetivo
  // do produto (order pricing lê promotionalPrice direto) → subtotal/comissão
  // negativos.
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  promotionalPrice: number;

  @Field()
  storeId: string;

  @Field({ nullable: true })
  @IsOptional()
  productId?: string;
}
