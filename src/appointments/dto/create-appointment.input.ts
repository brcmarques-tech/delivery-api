import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class CreateAppointmentInput {
  @Field()
  storeId: string;

  @Field()
  serviceId: string;

  @Field()
  scheduledDate: string;

  @Field()
  scheduledTime: string;

  @Field({ nullable: true })
  notes?: string;

  @Field({ nullable: true })
  address?: string;

  @Field({ nullable: true })
  latitude?: number;

  @Field({ nullable: true })
  longitude?: number;

  @Field({ nullable: true, description: 'ON_SERVICE | PIX | CREDIT_CARD' })
  paymentMethod?: string;

  @Field({ nullable: true })
  cardId?: string;

  @Field({ nullable: true })
  cardToken?: string;
}
