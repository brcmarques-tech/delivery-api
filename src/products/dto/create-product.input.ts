import { InputType, Field, Float } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsNumber, Min } from 'class-validator';

@InputType()
export class CreateProductInput {
  @Field()
  @IsNotEmpty()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  // KAN-253: sem validacao de faixa, dava pra cadastrar produto com preco
  // negativo — o que distorce subtotal/comissao e relatorios.
  @Field(() => Float)
  @IsNumber()
  @Min(0, { message: 'O preco nao pode ser negativo' })
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

  // KAN-253: estoque negativo tambem nao faz sentido.
  @Field({ nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'O estoque nao pode ser negativo' })
  stock?: number;

  @Field({ nullable: true })
  @IsOptional()
  barcode?: string;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  isVariableWeight?: boolean;
}
