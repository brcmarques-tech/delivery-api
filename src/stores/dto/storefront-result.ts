import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import { StoreType } from '../../common/enums/store-type.enum';
import { VerificationLevel } from '../../common/enums/verification-level.enum';

@ObjectType()
export class StorefrontProduct {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field({ nullable: true })
  description: string;

  @Field(() => Float)
  price: number;

  @Field(() => Float, { nullable: true })
  promotionalPrice: number | undefined;

  @Field({ nullable: true })
  imageUrl: string;

  @Field()
  isAvailable: boolean;

  @Field(() => Int, { nullable: true })
  stock: number;

  @Field({ nullable: true })
  unit: string;

  @Field()
  isVariableWeight: boolean;
}

@ObjectType()
export class StorefrontCategory {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field({ nullable: true })
  imageUrl: string;

  @Field(() => Int)
  sortOrder: number;

  @Field()
  requiresAgeVerification: boolean;

  @Field(() => [StorefrontProduct])
  products: StorefrontProduct[];
}

@ObjectType()
export class StorefrontResult {
  @Field(() => ID)
  id: string;

  @Field({ nullable: true })
  slug: string;

  @Field()
  name: string;

  @Field({ nullable: true })
  description: string;

  @Field({ nullable: true })
  logoUrl: string;

  @Field({ nullable: true })
  bannerUrl: string;

  @Field()
  phone: string;

  @Field()
  street: string;

  @Field()
  number: string;

  @Field({ nullable: true })
  complement: string;

  @Field()
  neighborhood: string;

  @Field()
  city: string;

  @Field()
  state: string;

  @Field()
  zipCode: string;

  @Field()
  isOpen: boolean;

  @Field()
  isActive: boolean;

  @Field(() => StoreType)
  storeType: StoreType;

  @Field()
  hasOwnDelivery: boolean;

  @Field()
  freeDelivery: boolean;

  @Field(() => Float)
  deliveryFee: number;

  @Field(() => Int)
  estimatedDeliveryMinutes: number;

  @Field(() => Float)
  minimumOrder: number;

  @Field({ nullable: true })
  deliveryStartTime: string;

  @Field({ nullable: true })
  deliveryEndTime: string;

  @Field(() => Float, { nullable: true })
  freeDeliveryAbove: number | undefined;

  @Field(() => VerificationLevel)
  verificationLevel: VerificationLevel;

  @Field(() => Float)
  averageRating: number;

  @Field(() => Int)
  totalRatings: number;

  @Field(() => [StorefrontCategory])
  categories: StorefrontCategory[];
}
