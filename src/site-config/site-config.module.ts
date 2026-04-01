import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SiteConfig } from './site-config.entity';
import { SiteConfigService } from './site-config.service';
import { SiteConfigResolver } from './site-config.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([SiteConfig])],
  providers: [SiteConfigService, SiteConfigResolver],
  exports: [SiteConfigService],
})
export class SiteConfigModule {}
