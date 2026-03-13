import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class RegisterDelivererInput {
  @Field()
  vehicleType: string;

  @Field({ nullable: true })
  vehiclePlate?: string;

  @Field({ nullable: true })
  identityPhotoUrl?: string;

  @Field()
  birthDate: string;

  @Field({ nullable: true })
  cnhNumber?: string;
}
