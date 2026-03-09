import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Address } from './entities/address.entity';
import { AddressesService } from './addresses.service';
import { AddressesResolver } from './addresses.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([Address])],
  providers: [AddressesService, AddressesResolver],
  exports: [AddressesService],
})
export class AddressesModule {}
