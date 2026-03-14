import { ObjectType, Field } from '@nestjs/graphql';
import { AppUser } from '../../users/entities/app-user.entity';

@ObjectType()
export class AppAuthResponse {
  @Field()
  accessToken: string;

  @Field(() => AppUser)
  user: AppUser;
}
