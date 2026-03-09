import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Address } from './entities/address.entity';
import { AddressesService } from './addresses.service';
import { CreateAddressInput } from './dto/create-address.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@Resolver(() => Address)
export class AddressesResolver {
  constructor(private addressesService: AddressesService) {}

  @Query(() => [Address])
  @UseGuards(GqlAuthGuard)
  myAddresses(@CurrentUser() user: User): Promise<Address[]> {
    return this.addressesService.findByUser(user.id);
  }

  @Mutation(() => Address)
  @UseGuards(GqlAuthGuard)
  createAddress(
    @Args('input') input: CreateAddressInput,
    @CurrentUser() user: User,
  ): Promise<Address> {
    return this.addressesService.create(input, user);
  }

  @Mutation(() => Address)
  @UseGuards(GqlAuthGuard)
  setDefaultAddress(
    @Args('id') id: string,
    @CurrentUser() user: User,
  ): Promise<Address> {
    return this.addressesService.setDefault(id, user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  deleteAddress(
    @Args('id') id: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.addressesService.delete(id, user.id);
  }
}
