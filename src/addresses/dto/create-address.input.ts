import { InputType, Field, Float } from '@nestjs/graphql';
import { IsOptional } from 'class-validator';

@InputType()
export class CreateAddressInput {
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

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  isDefault?: boolean;
}
