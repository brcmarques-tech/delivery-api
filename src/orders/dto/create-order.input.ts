import { InputType, Field, Float, Int } from '@nestjs/graphql';
import { IsOptional } from 'class-validator';

@InputType()
export class OrderItemInput {
  @Field()
  productId: string;

  @Field(() => Int)
  quantity: number;

  @Field({ nullable: true })
  notes?: string;

  @Field(() => Int, { nullable: true })
  weightGrams?: number;
}

@InputType()
export class CreateOrderInput {
  @Field()
  storeId: string;

  @Field(() => [OrderItemInput])
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
}
