import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Store } from './entities/store.entity';
import { CreateStoreInput } from './dto/create-store.input';
import { User } from '../users/entities/user.entity';

@Injectable()
export class StoresService {
  constructor(
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
  ) {}

  async create(input: CreateStoreInput, owner: User): Promise<Store> {
    const store = this.storesRepository.create({ ...input, owner });
    return this.storesRepository.save(store);
  }

  async findAll(): Promise<Store[]> {
    return this.storesRepository.find({
      where: { isActive: true },
      relations: ['owner', 'categories'],
    });
  }

  async findById(id: string): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { id },
      relations: ['owner', 'products', 'categories'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    return store;
  }

  async findByOwner(ownerId: string): Promise<Store[]> {
    return this.storesRepository.find({
      where: { owner: { id: ownerId } },
      relations: ['products', 'categories'],
    });
  }

  async findNearby(lat: number, lng: number, radiusKm: number = 10): Promise<Store[]> {
    return this.storesRepository
      .createQueryBuilder('store')
      .where('store.isActive = :active', { active: true })
      .andWhere('store.isOpen = :open', { open: true })
      .andWhere(
        `(6371 * acos(cos(radians(:lat)) * cos(radians(store.latitude)) * cos(radians(store.longitude) - radians(:lng)) + sin(radians(:lat)) * sin(radians(store.latitude)))) <= :radius`,
        { lat, lng, radius: radiusKm },
      )
      .getMany();
  }

  async toggleOpen(id: string, owner: User): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { id, owner: { id: owner.id } },
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    store.isOpen = !store.isOpen;
    return this.storesRepository.save(store);
  }
}
