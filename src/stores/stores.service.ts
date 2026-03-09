import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Store } from './entities/store.entity';
import { CreateStoreInput } from './dto/create-store.input';
import { UpdateStoreInput } from './dto/update-store.input';
import { User } from '../users/entities/user.entity';
import { getPlanConfig } from '../common/plan-config';

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);

  constructor(
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
  ) {}

  /**
   * Geocode an address to lat/lng using Nominatim (OpenStreetMap).
   * Tries progressively simpler queries if the full address fails.
   */
  private async geocodeAddress(input: CreateStoreInput): Promise<{ latitude: number; longitude: number }> {
    const queries = [
      `${input.street}, ${input.number}, ${input.neighborhood}, ${input.city}, ${input.state}, Brazil`,
      `${input.street}, ${input.number}, ${input.city}, ${input.state}, Brazil`,
      `${input.street}, ${input.city}, ${input.state}, Brazil`,
      `${input.neighborhood}, ${input.city}, ${input.state}, Brazil`,
      `${input.city}, ${input.state}, Brazil`,
    ];

    for (const query of queries) {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'bcmTech-Delivery/1.0' },
        });
        const data = await res.json();
        if (data.length > 0) {
          this.logger.log(`Geocoded with query: "${query}"`);
          return { latitude: parseFloat(data[0].lat), longitude: parseFloat(data[0].lon) };
        }
      } catch (err) {
        this.logger.warn(`Geocoding attempt failed for: ${query}`, err);
      }
    }

    throw new BadRequestException(
      'Nao foi possivel localizar o endereco. Verifique os dados e tente novamente.',
    );
  }

  async create(input: CreateStoreInput, owner: User): Promise<Store> {
    const planConfig = getPlanConfig(owner.vendorPlan);
    const currentStores = await this.storesRepository.count({
      where: { owner: { id: owner.id } },
    });

    if (currentStores >= planConfig.maxStores) {
      throw new BadRequestException(
        `Seu plano permite no maximo ${planConfig.maxStores} loja(s). Faca upgrade para criar mais.`,
      );
    }

    // Geocode address if lat/lng not provided
    if (!input.latitude || !input.longitude) {
      const coords = await this.geocodeAddress(input);
      input.latitude = coords.latitude;
      input.longitude = coords.longitude;
    }

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
      relations: ['owner', 'products', 'products.category', 'categories'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    return store;
  }

  async findByOwner(ownerId: string): Promise<Store[]> {
    return this.storesRepository.find({
      where: { owner: { id: ownerId } },
      relations: ['owner', 'products', 'products.category', 'categories'],
    });
  }

  async findNearby(lat: number, lng: number, radiusKm: number = 10): Promise<Store[]> {
    return this.storesRepository
      .createQueryBuilder('store')
      .leftJoinAndSelect('store.owner', 'owner')
      .where('store.isActive = :active', { active: true })
      .andWhere(
        `(6371 * acos(cos(radians(:lat)) * cos(radians(store.latitude)) * cos(radians(store.longitude) - radians(:lng)) + sin(radians(:lat)) * sin(radians(store.latitude)))) <= :radius`,
        { lat, lng, radius: radiusKm },
      )
      .getMany();
  }

  async update(input: UpdateStoreInput, owner: User): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { id: input.id, owner: { id: owner.id } },
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    const { id, ...updates } = input;
    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) (store as any)[key] = value;
    });
    return this.storesRepository.save(store);
  }

  async toggleOpen(id: string, owner: User): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { id, owner: { id: owner.id } },
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    store.isOpen = !store.isOpen;
    return this.storesRepository.save(store);
  }

  async findAllAdmin(): Promise<Store[]> {
    return this.storesRepository.find({
      relations: ['owner', 'products', 'products.category', 'categories'],
      order: { createdAt: 'DESC' },
    });
  }

  async toggleActive(id: string): Promise<Store> {
    const store = await this.storesRepository.findOne({ where: { id } });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    store.isActive = !store.isActive;
    return this.storesRepository.save(store);
  }

  async totalCount(): Promise<number> {
    return this.storesRepository.count();
  }
}
