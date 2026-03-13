import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Store } from './entities/store.entity';
import { User } from '../users/entities/user.entity';
import { Coupon } from '../coupons/entities/coupon.entity';
import { StoresService } from './stores.service';
import { StoresResolver } from './stores.resolver';
import { VerificationService } from './verification.service';
import { PlatformConfigModule } from '../config/platform-config.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Store, User, Coupon]),
    PlatformConfigModule,
    forwardRef(() => DeliveriesModule),
  ],
  providers: [StoresService, StoresResolver, VerificationService],
  exports: [StoresService, VerificationService],
})
export class StoresModule {}
