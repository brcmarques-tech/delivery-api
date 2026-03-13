import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Coupon } from './entities/coupon.entity';
import { Store } from '../stores/entities/store.entity';
import { CouponsService } from './coupons.service';
import { CouponsResolver } from './coupons.resolver';
import { PlatformConfigModule } from '../config/platform-config.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Coupon, Store]),
    PlatformConfigModule,
  ],
  providers: [CouponsService, CouponsResolver],
  exports: [CouponsService],
})
export class CouponsModule {}
