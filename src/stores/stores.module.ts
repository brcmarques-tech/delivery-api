import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Store } from './entities/store.entity';
import { StoresService } from './stores.service';
import { StoresResolver } from './stores.resolver';
import { PlatformConfigModule } from '../config/platform-config.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Store]),
    PlatformConfigModule,
    forwardRef(() => DeliveriesModule),
  ],
  providers: [StoresService, StoresResolver],
  exports: [StoresService],
})
export class StoresModule {}
