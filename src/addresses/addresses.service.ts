import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Address } from './entities/address.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { CreateAddressInput } from './dto/create-address.input';

@Injectable()
export class AddressesService {
  constructor(
    @InjectRepository(Address)
    private addressesRepository: Repository<Address>,
  ) {}

  async create(input: CreateAddressInput, user: AppUser): Promise<Address> {
    if (input.isDefault) {
      await this.addressesRepository.update(
        { user: { id: user.id } },
        { isDefault: false },
      );
    }
    const address = this.addressesRepository.create({ ...input, user });
    return this.addressesRepository.save(address);
  }

  async findByUser(userId: string): Promise<Address[]> {
    return this.addressesRepository.find({
      where: { user: { id: userId } },
      order: { isDefault: 'DESC', createdAt: 'DESC' },
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

  async delete(addressId: string, userId: string): Promise<boolean> {
    const address = await this.addressesRepository.findOne({
      where: { id: addressId, user: { id: userId } },
    });
    if (!address) throw new NotFoundException('Endereco nao encontrado');
    await this.addressesRepository.remove(address);
    return true;
  }

  async saveFromOrder(
    deliveryAddress: string,
    latitude: number,
    longitude: number,
    user: AppUser,
  ): Promise<void> {
    const existing = await this.addressesRepository
      .createQueryBuilder('a')
      .where('a.userId = :userId', { userId: user.id })
      .andWhere(
        'ABS(a.latitude - :lat) < 0.001 AND ABS(a.longitude - :lng) < 0.001',
        { lat: latitude, lng: longitude },
      )
      .getOne();

    if (existing) return;

    const parts = deliveryAddress.split(',').map((p) => p.trim());
    const address = this.addressesRepository.create({
      street: parts[0] || deliveryAddress,
      number: parts[1] || 'S/N',
      neighborhood: parts[2] || '',
      city: parts[3] || '',
      state: parts[4] || '',
      zipCode: '',
      latitude,
      longitude,
      isDefault: false,
      user,
    });
    await this.addressesRepository.save(address);
  }
}
