import { ObjectType, Field } from '@nestjs/graphql';
import { VendorUser } from '../../users/entities/vendor-user.entity';

@ObjectType()
export class VendorAuthResponse {
  @Field()
  accessToken: string;

  @Field(() => VendorUser)
  user: VendorUser;
}
