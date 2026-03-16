import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class VerifyCodeInput {
  @Field()
  value: string; // phone number or email

  @Field()
  code: string;

  @Field()
  channel: 'whatsapp' | 'email';
}
