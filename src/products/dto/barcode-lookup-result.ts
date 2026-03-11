import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
export class BarcodeLookupResult {
  @Field()
  barcode: string;

  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  imageUrl?: string;

  @Field({ nullable: true })
  brand?: string;

  @Field({ nullable: true })
  quantity?: string;
}
