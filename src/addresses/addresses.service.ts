import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Address } from './entities/address.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { CreateAddressInput } from './dto/create-address.input';
import { UpdateAddressInput } from './dto/update-address.input';

@Injectable()
export class AddressesService {
  private readonly logger = new Logger(AddressesService.name);

  constructor(
    @InjectRepository(Address)
    private addressesRepository: Repository<Address>,
  ) {}

  private isInBrazil(lat: number, lng: number): boolean {
    // Bounding box do Brasil: lat -34 a 5, lng -74 a -34
    return lat >= -34 && lat <= 6 && lng >= -74 && lng <= -34;
  }

  private async geocodeAddress(input: { street?: string; number?: string; neighborhood?: string; city?: string; state?: string }): Promise<{ latitude: number; longitude: number } | null> {
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
          headers: { 'User-Agent': 'bcmTech-Shopping/1.0' },
        });
        const data = await res.json();
        if (data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lng = parseFloat(data[0].lon);
          if (this.isInBrazil(lat, lng)) {
            this.logger.log(`Endereco geocodificado: "${query}" -> ${lat}, ${lng}`);
            return { latitude: lat, longitude: lng };
          }
          this.logger.warn(`Geocoding retornou coordenadas fora do Brasil para: "${query}" -> ${lat}, ${lng}`);
        }
      } catch (err) {
        this.logger.warn(`Geocoding falhou para: ${query}`);
      }
    }
    return null;
  }

  async create(input: CreateAddressInput, user: AppUser): Promise<Address> {
    if (input.isDefault) {
      await this.addressesRepository.update(
        { user: { id: user.id } },
        { isDefault: false },
      );
    }

    // Prioridade é o endereço textual — recalcula coordenadas pelo endereço
    if (input.street && input.city && input.state) {
      const coords = await this.geocodeAddress(input);
      if (coords) {
        input.latitude = coords.latitude;
        input.longitude = coords.longitude;
      }
      // Se geocoding falhou, mantém as coordenadas originais do frontend
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

  async update(input: UpdateAddressInput, userId: string): Promise<Address> {
    const address = await this.addressesRepository.findOne({
      where: { id: input.id, user: { id: userId } },
    });
    if (!address) throw new NotFoundException('Endereco nao encontrado');

    const { id, ...fields } = input;
    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined) {
        (address as any)[key] = value;
      }
    });

    // Re-geocode if address text changed and no new coords were sent
    const addressChanged = fields.street || fields.number || fields.neighborhood || fields.city || fields.state;
    if (addressChanged && !fields.latitude && !fields.longitude) {
      const coords = await this.geocodeAddress({
        street: address.street,
        number: address.number,
        neighborhood: address.neighborhood,
        city: address.city,
        state: address.state,
      });
      if (coords) {
        address.latitude = coords.latitude;
        address.longitude = coords.longitude;
      }
    }

    return this.addressesRepository.save(address);
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
