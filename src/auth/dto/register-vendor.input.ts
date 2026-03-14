import { InputType, Field } from '@nestjs/graphql';
import { IsEmail, MinLength } from 'class-validator';

@InputType()
export class RegisterVendorInput {
  @Field()
  name: string;

  @Field()
  @IsEmail()
  email: string;

  @Field()
  @MinLength(6)
  password: string;

  @Field()
  phone: string;

  @Field()
  cpf: string;
}
