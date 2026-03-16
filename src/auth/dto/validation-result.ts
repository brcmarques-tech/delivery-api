import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
export class ValidationResult {
  @Field()
  valid: boolean;

  @Field({ nullable: true })
  emailError: string;

  @Field({ nullable: true })
  cpfError: string;

  @Field({ nullable: true })
  phoneError: string;
}
