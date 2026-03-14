import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Store } from './entities/store.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { Coupon } from '../coupons/entities/coupon.entity';
import { StoresService } from './stores.service';
import { StoresResolver } from './stores.resolver';
import { StoresController } from './stores.controller';
import { VerificationService } from './verification.service';
import { PlatformConfigModule } from '../config/platform-config.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Store, VendorUser, AppUser, Coupon]),
    PlatformConfigModule,
    forwardRef(() => DeliveriesModule),
  ],
  controllers: [StoresController],
  providers: [StoresService, StoresResolver, VerificationService],
  exports: [StoresService, VerificationService],
})
export class StoresModule {}
