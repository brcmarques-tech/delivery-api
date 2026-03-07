import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Promotion } from './entities/promotion.entity';
import { PromotionsService } from './promotions.service';
import { PromotionsResolver } from './promotions.resolver';
import { StoresModule } from '../stores/stores.module';

@Module({
  imports: [TypeOrmModule.forFeature([Promotion]), StoresModule],
  providers: [PromotionsService, PromotionsResolver],
  exports: [PromotionsService],
})
export class PromotionsModule {}
