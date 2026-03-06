import { InputType, Field } from '@nestjs/graphql';
import { IsEmail, MinLength, IsEnum, IsOptional } from 'class-validator';
import { UserRole } from '../../common/enums';

@InputType()
export class RegisterInput {
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

  @Field(() => UserRole, { nullable: true })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
