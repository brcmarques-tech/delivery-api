import { Resolver, Query, Mutation, Args, ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { CartItem } from './entities/cart-item.entity';
import { CartService } from './cart.service';
import { AddToCartInput } from './dto/add-to-cart.input';
import { UpdateCartItemInput } from './dto/update-cart-item.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AppUser } from '../users/entities/app-user.entity';
import { UserRole } from '../common/enums';

@ObjectType()
class CartProductSummary {
  @Field(() => ID)
  productId: string;

  @Field()
  productName: string;

  @Field({ nullable: true })
  productImageUrl: string;

  @Field(() => Int)
  totalPeople: number;

  @Field(() => Int)
  totalQuantity: number;
}

@Resolver(() => CartItem)
export class CartResolver {
  constructor(private cartService: CartService) {}

  @Mutation(() => CartItem)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  addToCart(
    @Args('input') input: AddToCartInput,
    @CurrentUser() user: AppUser,
  ): Promise<CartItem> {
    return this.cartService.addToCart(input, user.id);
  }

  @Mutation(() => CartItem)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  updateCartItem(
    @Args('input') input: UpdateCartItemInput,
    @CurrentUser() user: AppUser,
  ): Promise<CartItem> {
    return this.cartService.updateCartItem(input, user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  removeFromCart(
    @Args('cartItemId') cartItemId: string,
    @CurrentUser() user: AppUser,
  ): Promise<boolean> {
    return this.cartService.removeFromCart(cartItemId, user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  clearCart(@CurrentUser() user: AppUser): Promise<boolean> {
    return this.cartService.clearCart(user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  clearCartByStore(
    @Args('storeId') storeId: string,
    @CurrentUser() user: AppUser,
  ): Promise<boolean> {
    return this.cartService.clearCartByStore(user.id, storeId);
  }

  @Query(() => [CartItem])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  myCart(@CurrentUser() user: AppUser): Promise<CartItem[]> {
    return this.cartService.getMyCart(user.id);
  }

  @Query(() => [CartProductSummary])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  storeCartSummary(
    @Args('storeId') storeId: string,
  ): Promise<CartProductSummary[]> {
    return this.cartService.getStoreCartSummary(storeId);
  }

  @Query(() => [CartItem])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  myCartByStore(
    @Args('storeId') storeId: string,
    @CurrentUser() user: AppUser,
  ): Promise<CartItem[]> {
    return this.cartService.getMyCartByStore(user.id, storeId);
  }
}
