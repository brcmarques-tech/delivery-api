import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformConfigService } from './platform-config.service';
import { PlatformConfigResolver } from './platform-config.resolver';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([PlatformConfig, AppUser, VendorUser])],
  providers: [PlatformConfigService, PlatformConfigResolver],
  exports: [PlatformConfigService],
})
export class PlatformConfigModule {}
