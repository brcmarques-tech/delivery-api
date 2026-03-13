import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformConfigService } from './platform-config.service';
import { PlatformConfigResolver } from './platform-config.resolver';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([PlatformConfig, User])],
  providers: [PlatformConfigService, PlatformConfigResolver],
  exports: [PlatformConfigService],
})
export class PlatformConfigModule {}
