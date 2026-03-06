import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';
import { CreateProductInput } from './dto/create-product.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';

@Resolver(() => Product)
export class ProductsResolver {
  constructor(private productsService: ProductsService) {}

  @Mutation(() => Product)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR, UserRole.ADMIN)
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
  toggleProductAvailability(@Args('id') id: string): Promise<Product> {
    return this.productsService.toggleAvailability(id);
  }
}
