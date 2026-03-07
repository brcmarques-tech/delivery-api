import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class RegisterDelivererInput {
  @Field()
  cpf: string;

  @Field()
  vehicleType: string;

  @Field({ nullable: true })
  vehiclePlate?: string;

  @Field({ nullable: true })
  identityPhotoUrl?: string;
}
