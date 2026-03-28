import { InputType, Field, Float } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional } from 'class-validator';
import { StoreType } from '../../common/enums';

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

  @Field(() => Float, { nullable: true })
  @IsOptional()
  latitude?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  longitude?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  deliveryFee?: number;

  @Field({ nullable: true })
  @IsOptional()
  estimatedDeliveryMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  minimumOrder?: number;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  hasOwnDelivery?: boolean;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  freeDelivery?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  deliveryStartTime?: string;

  @Field({ nullable: true })
  @IsOptional()
  deliveryEndTime?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  freeDeliveryAbove?: number;

  @Field({ nullable: true })
  @IsOptional()
  logoUrl?: string;

  @Field({ nullable: true })
  @IsOptional()
  bannerUrl?: string;

  @Field(() => StoreType, { nullable: true, defaultValue: StoreType.PRODUCTS })
  @IsOptional()
  storeType?: StoreType;
}
