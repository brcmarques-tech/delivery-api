import { InputType, Field, Float } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional } from 'class-validator';

@InputType()
export class CreateStoreInput {
  @Field()
  @IsNotEmpty()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  @Field()
  phone: string;

  @Field()
  street: string;

  @Field()
  number: string;

  @Field({ nullable: true })
  @IsOptional()
  complement?: string;

  @Field()
  neighborhood: string;

  @Field()
  city: string;

  @Field()
  state: string;

  @Field()
  zipCode: string;

  @Field(() => Float)
  latitude: number;

  @Field(() => Float)
  longitude: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  deliveryFee?: number;

  @Field({ nullable: true })
  @IsOptional()
  estimatedDeliveryMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  minimumOrder?: number;
}
