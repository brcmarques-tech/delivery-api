import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppUser } from './entities/app-user.entity';
import { VendorUser } from './entities/vendor-user.entity';
import { AppUsersService } from './app-users.service';
import { VendorUsersService } from './vendor-users.service';
import { AppUsersResolver } from './app-users.resolver';
import { VendorUsersResolver } from './vendor-users.resolver';
import { PlatformConfigModule } from '../config/platform-config.module';
import { StoresModule } from '../stores/stores.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppUser, VendorUser]),
    PlatformConfigModule,
    forwardRef(() => StoresModule),
  ],
  providers: [AppUsersService, VendorUsersService, AppUsersResolver, VendorUsersResolver],
  exports: [AppUsersService, VendorUsersService],
})
export class UsersModule {}
