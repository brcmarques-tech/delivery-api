import { Resolver, Query, Mutation, Args, Subscription, ObjectType, Field, ID } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

@ObjectType()
class ProductDeletedPayload {
  @Field(() => ID)
  id: string;

  @Field({ nullable: true })
  storeId?: string;
}

@Resolver(() => Product)
export class ProductsResolver {
  constructor(
    private productsService: ProductsService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  @Mutation(() => Product)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createProduct(@Args('input') input: CreateProductInput): Promise<Product> {
    return this.productsService.create(input);
  }

  @Query(() => [Product])
  productsByStore(@Args('storeId') storeId: string): Promise<Product[]> {
    return this.productsService.findByStore(storeId);
  }

  @Query(() => Product)
  product(@Args('id') id: string): Promise<Product> {
    return this.productsService.findById(id);
  }

  @Mutation(() => Product)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  updateProduct(@Args('input') input: UpdateProductInput): Promise<Product> {
    return this.productsService.update(input);
  }

  @Mutation(() => Product)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  toggleProductAvailability(@Args('id') id: string): Promise<Product> {
    return this.productsService.toggleAvailability(id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  deleteProduct(@Args('id') id: string): Promise<boolean> {
    return this.productsService.delete(id);
  }

  @Subscription(() => Product, {
    filter: (payload, variables) =>
      !variables.storeId || payload.productUpdated.store?.id === variables.storeId,
  })
  productUpdated(@Args('storeId', { nullable: true }) storeId?: string) {
    return this.pubSub.asyncIterableIterator('productUpdated');
  }

  @Subscription(() => ProductDeletedPayload, {
    filter: (payload, variables) =>
      !variables.storeId || payload.productDeleted.storeId === variables.storeId,
  })
  productDeleted(@Args('storeId', { nullable: true }) storeId?: string) {
    return this.pubSub.asyncIterableIterator('productDeleted');
  }
}
