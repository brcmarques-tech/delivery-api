import { InputType, Field, Float, Int } from '@nestjs/graphql';

@InputType()
export class OrderItemInput {
  @Field()
  productId: string;

  @Field(() => Int)
  quantity: number;

  @Field({ nullable: true })
  notes?: string;
}

@InputType()
export class CreateOrderInput {
  @Field()
  storeId: string;

  @Field(() => [OrderItemInput])
  items: OrderItemInput[];

  @Field()
  deliveryAddress: string;

  @Field(() => Float)
  deliveryLatitude: number;

  @Field(() => Float)
  deliveryLongitude: number;

  @Field({ nullable: true })
  notes?: string;

  @Field({ nullable: true, defaultValue: 'ON_DELIVERY' })
  paymentMethod?: string;
}
