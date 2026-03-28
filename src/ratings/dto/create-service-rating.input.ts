import { InputType, Field, Int } from '@nestjs/graphql';

@InputType()
export class CreateServiceRatingInput {
  @Field()
  appointmentId: string;

  @Field(() => Int)
  rating: number;

  @Field({ nullable: true })
  comment?: string;

  @Field(() => [String], { nullable: true })
  photoUrls?: string[];
}
