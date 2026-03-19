import { Resolver, Query, Mutation, Args, Subscription, ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { BulkCreateProductsInput, BulkImportResult } from './dto/bulk-create-products.input';
import { BarcodeLookupResult } from './dto/barcode-lookup-result';
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

  @Query(() => [Product])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  productsByStoreAll(@Args('storeId') storeId: string): Promise<Product[]> {
    return this.productsService.findByStoreAll(storeId);
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

  @Mutation(() => Product)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  toggleProductActive(@Args('id') id: string): Promise<Product> {
    return this.productsService.toggleActive(id);
  }

  @Query(() => [Product])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  deletedProductsByStore(@Args('storeId') storeId: string): Promise<Product[]> {
    return this.productsService.findDeletedByStore(storeId);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  deleteProduct(@Args('id') id: string): Promise<boolean> {
    return this.productsService.delete(id);
  }

  @Mutation(() => Product)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  restoreProduct(@Args('id') id: string): Promise<Product> {
    return this.productsService.restore(id);
  }

  @Query(() => BarcodeLookupResult)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  lookupBarcode(@Args('barcode') barcode: string): Promise<BarcodeLookupResult> {
    return this.productsService.lookupBarcode(barcode);
  }

  @Mutation(() => BulkImportResult)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  bulkCreateProducts(@Args('input') input: BulkCreateProductsInput): Promise<BulkImportResult> {
    return this.productsService.bulkCreate(input);
  }

  @Query(() => [Product])
  searchProducts(
    @Args('query') query: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
  ): Promise<Product[]> {
    return this.productsService.searchPublic(query, limit);
  }

  @Query(() => [Product])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  searchCatalog(
    @Args('query') query: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
  ): Promise<Product[]> {
    return this.productsService.searchCatalog(query, limit);
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
