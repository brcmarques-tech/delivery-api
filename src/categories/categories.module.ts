import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from './entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { CategoriesService } from './categories.service';
import { CategoriesResolver } from './categories.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([Category, Product])],
  providers: [CategoriesService, CategoriesResolver],
  exports: [CategoriesService],
})
export class CategoriesModule {}
