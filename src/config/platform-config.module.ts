import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformConfigService } from './platform-config.service';
import { PlatformConfigResolver } from './platform-config.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([PlatformConfig])],
  providers: [PlatformConfigService, PlatformConfigResolver],
  exports: [PlatformConfigService],
})
export class PlatformConfigModule {}
