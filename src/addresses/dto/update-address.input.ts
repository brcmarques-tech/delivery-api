import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsOptional } from 'class-validator';

@InputType()
export class UpdateAddressInput {
  @Field(() => ID)
  id: string;

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
  latitude?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  longitude?: number;
}
