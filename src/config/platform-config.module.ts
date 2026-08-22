import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformConfigService } from './platform-config.service';
import { PlatformConfigResolver } from './platform-config.resolver';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlatformConfig, AppUser, VendorUser]),
    // forwardRef (ciclo com PaymentsModule): updatePlanConfig precisa disparar
    // o syncPlans do SubscriptionPlansService para alinhar o preco no Pagar.me.
    forwardRef(() => PaymentsModule),
  ],
  providers: [PlatformConfigService, PlatformConfigResolver],
  exports: [PlatformConfigService],
})
export class PlatformConfigModule {}
