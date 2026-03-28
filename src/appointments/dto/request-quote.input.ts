import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class RequestQuoteInput {
  @Field()
  storeId: string;

  @Field()
  serviceId: string;

  @Field()
  description: string;

  @Field({ nullable: true })
  address?: string;

  @Field({ nullable: true })
  latitude?: number;

  @Field({ nullable: true })
  longitude?: number;
}
