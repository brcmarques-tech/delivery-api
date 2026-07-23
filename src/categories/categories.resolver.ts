import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Category } from './entities/category.entity';
import { CategoriesService } from './categories.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../common/enums';

@Resolver(() => Category)
export class CategoriesResolver {
  constructor(private categoriesService: CategoriesService) {}

  @Mutation(() => Category)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createCategory(
    @Args('name') name: string,
    @Args('storeId') storeId: string,
    @Args('requiresAgeVerification', { nullable: true, defaultValue: false }) requiresAgeVerification: boolean,
    @CurrentUser() user: any,
  ): Promise<Category> {
    return this.categoriesService.create(name, storeId, requiresAgeVerification, user.id);
  }

  @Mutation(() => Category)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  updateCategory(
    @Args('id') id: string,
    @CurrentUser() user: any,
    @Args('name', { nullable: true }) name?: string,
    @Args('requiresAgeVerification', { nullable: true }) requiresAgeVerification?: boolean,
  ): Promise<Category> {
    return this.categoriesService.update(id, { name, requiresAgeVerification }, user.id);
  }

  @Query(() => [Category])
  categoriesByStore(@Args('storeId') storeId: string): Promise<Category[]> {
    return this.categoriesService.findByStore(storeId);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  deleteCategory(@Args('id') id: string, @CurrentUser() user: any): Promise<boolean> {
    return this.categoriesService.delete(id, user.id);
  }
}
