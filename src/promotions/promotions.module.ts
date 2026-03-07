import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Promotion } from './entities/promotion.entity';
import { Product } from '../products/entities/product.entity';
import { PromotionsService } from './promotions.service';
import { PromotionsResolver } from './promotions.resolver';
import { StoresModule } from '../stores/stores.module';
import { PlatformConfigModule } from '../config/platform-config.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Promotion, Product]),
    StoresModule,
    PlatformConfigModule,
    PaymentsModule,
  ],
  providers: [PromotionsService, PromotionsResolver],
  exports: [PromotionsService],
})
export class PromotionsModule {}
