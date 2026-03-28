import { InputType, Field, Float } from '@nestjs/graphql';
import { IsOptional } from 'class-validator';
import { StoreType } from '../../common/enums';

@InputType()
export class UpdateStoreInput {
  @Field()
  id: string;

  @Field({ nullable: true })
  @IsOptional()
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  phone?: string;

  @Field({ nullable: true })
  @IsOptional()
  street?: string;

  @Field({ nullable: true })
  @IsOptional()
  number?: string;

  @Field({ nullable: true })
  @IsOptional()
  complement?: string;

  @Field({ nullable: true })
  @IsOptional()
  neighborhood?: string;

  @Field({ nullable: true })
  @IsOptional()
  city?: string;

  @Field({ nullable: true })
  @IsOptional()
  state?: string;

  @Field({ nullable: true })
  @IsOptional()
  zipCode?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  deliveryFee?: number;

  @Field({ nullable: true })
  @IsOptional()
  estimatedDeliveryMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  minimumOrder?: number;

  @Field({ nullable: true })
  @IsOptional()
  hasOwnDelivery?: boolean;

  @Field({ nullable: true })
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

  @Field(() => Float, { nullable: true })
  @IsOptional()
  latitude?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  longitude?: number;

  @Field(() => StoreType, { nullable: true })
  @IsOptional()
  storeType?: StoreType;
}
