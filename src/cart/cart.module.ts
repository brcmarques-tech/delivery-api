import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CartItem } from './entities/cart-item.entity';
import { Product } from '../products/entities/product.entity';
import { CartService } from './cart.service';
import { CartResolver } from './cart.resolver';
import { StoresModule } from '../stores/stores.module';

@Module({
  imports: [TypeOrmModule.forFeature([CartItem, Product]), StoresModule],
  providers: [CartService, CartResolver],
  exports: [CartService],
})
export class CartModule {}
