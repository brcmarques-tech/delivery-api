import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformConfig } from './entities/platform-config.entity';

@Injectable()
export class PlatformConfigService {
  constructor(
    @InjectRepository(PlatformConfig)
    private configRepository: Repository<PlatformConfig>,
  ) {}

  async get(key: string, defaultValue: string = '0'): Promise<string> {
    const config = await this.configRepository.findOne({ where: { key } });
    return config?.value ?? defaultValue;
  }

  async set(key: string, value: string): Promise<PlatformConfig> {
    let config = await this.configRepository.findOne({ where: { key } });
    if (config) {
      config.value = value;
    } else {
      config = this.configRepository.create({ key, value });
    }
    return this.configRepository.save(config);
  }

  async getAll(): Promise<PlatformConfig[]> {
    return this.configRepository.find();
  }

  async getPromoPricePerDay(): Promise<number> {
    const value = await this.get('promo_price_per_day', '1');
    return parseFloat(value);
  }
}
