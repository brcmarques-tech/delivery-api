import { InputType, Field, Float, Int } from '@nestjs/graphql';
import { IsOptional, IsInt, Min, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class OrderItemInput {
  @Field()
  productId: string;

  // Sem @Min(1), quantidade negativa abatia o subtotal (pagar a menos) e, no
  // decremento stock - $1, inflava o estoque burlando a guarda (KAN-211).
  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity: number;

  @Field({ nullable: true })
  notes?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  weightGrams?: number;
}

@InputType()
export class CreateOrderInput {
  @Field()
  storeId: string;

  // @ValidateNested + @Type sao obrigatorios para o ValidationPipe descer nos
  // itens do array — sem eles, as regras de OrderItemInput acima nao rodam.
  // BUGFIX: @ValidateNested valida os ELEMENTOS — um array VAZIO passava. Numa
  // loja com minimo 0 e entrega propria, dava para criar pedido sem item nenhum
  // (subtotal 0, total = so o frete) e o vendedor recebia push de "Novo pedido!"
  // para nada.
  @Field(() => [OrderItemInput])
  @ArrayMinSize(1, { message: 'O pedido precisa ter pelo menos um item.' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemInput)
  items: OrderItemInput[];

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  isPickup?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  deliveryAddress?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  deliveryLatitude?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  deliveryLongitude?: number;

  @Field({ nullable: true })
  notes?: string;

  @Field({ nullable: true, defaultValue: 'ON_DELIVERY' })
  paymentMethod?: string;

  @Field({ nullable: true })
  @IsOptional()
  couponCode?: string;

  @Field({ nullable: true })
  @IsOptional()
  cardId?: string;

  @Field({ nullable: true })
  @IsOptional()
  cardToken?: string;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  ageVerified?: boolean;
}
