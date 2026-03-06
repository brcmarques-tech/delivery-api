import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Address } from './entities/address.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class AddressesService {
  constructor(
    @InjectRepository(Address)
    private addressesRepository: Repository<Address>,
  ) {}

  async create(input: Partial<Address>, user: User): Promise<Address> {
    const address = this.addressesRepository.create({ ...input, user });
    return this.addressesRepository.save(address);
  }

  async findByUser(userId: string): Promise<Address[]> {
    return this.addressesRepository.find({
      where: { user: { id: userId } },
    });
  }

  async setDefault(addressId: string, userId: string): Promise<Address> {
    await this.addressesRepository.update(
      { user: { id: userId } },
      { isDefault: false },
    );
    await this.addressesRepository.update(addressId, { isDefault: true });
    return this.addressesRepository.findOneOrFail({ where: { id: addressId } });
  }
}
