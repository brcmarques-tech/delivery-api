import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';
import { ProductsResolver } from './products.resolver';
import { Store } from '../stores/entities/store.entity';
import { PlatformConfigModule } from '../config/platform-config.module';
import { StoresModule } from '../stores/stores.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, Store]),
    // Error#1: timeout p/ o lookup de código de barras (OpenFoodFacts) não pinar
    // a criação de produto se o serviço externo travar.
    HttpModule.register({ timeout: 8000 }),
    PlatformConfigModule,
    forwardRef(() => StoresModule),
  ],
  providers: [ProductsService, ProductsResolver],
  exports: [ProductsService],
})
export class ProductsModule {}
