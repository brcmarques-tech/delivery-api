import { InputType, Field, Int } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, Min, IsInt } from 'class-validator';


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

  // BUGFIX: `quantity` tinha @Min(1) mas `weightGrams` nao tinha validacao
  // nenhuma — um peso negativo era gravado no carrinho e a tela mostrava total
  // de linha negativo, corrompendo o subtotal exibido. O DTO do PEDIDO ja
  // validava (@IsInt @Min(1)); os do carrinho ficaram inconsistentes.
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  weightGrams?: number;
}
