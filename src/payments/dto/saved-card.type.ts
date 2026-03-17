import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class SavedCard {
  @Field(() => ID)
  id: string;

  @Field()
  lastFourDigits: string;

  @Field()
  brand: string;

  @Field({ nullable: true })
  holderName: string;

  @Field({ nullable: true })
  expMonth: number;

  @Field({ nullable: true })
  expYear: number;
}
