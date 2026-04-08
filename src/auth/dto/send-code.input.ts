import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class SendCodeInput {
  @Field()
  value: string; // phone number or email

  @Field()
  channel: 'whatsapp' | 'email';

  @Field({ nullable: true })
  fallbackEmail?: string; // email to use if WhatsApp fails

  @Field({ nullable: true })
  fallbackPhone?: string; // phone to use if email fails
}
