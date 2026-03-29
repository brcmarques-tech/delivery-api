import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Service } from './entities/service.entity';
import { CreateServiceInput } from './dto/create-service.input';
import { UpdateServiceInput } from './dto/update-service.input';
import { Store } from '../stores/entities/store.entity';
import { StoreType } from '../common/enums';

@Injectable()
export class ServicesService {
  constructor(
    @InjectRepository(Service)
    private servicesRepository: Repository<Service>,
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
  ) {}

  private async validateStoreOwnership(storeId: string, ownerId: string): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { id: storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    if (store.owner?.id !== ownerId) {
      throw new BadRequestException('Voce nao tem permissao para gerenciar servicos desta loja.');
    }
    if (store.storeType !== StoreType.SERVICES) {
      throw new BadRequestException('Esta loja nao e do tipo SERVICES. Altere o tipo da loja primeiro.');
    }
    return store;
  }

  async create(input: CreateServiceInput, owner: any): Promise<Service> {
    await this.validateStoreOwnership(input.storeId, owner.id);

    const service = this.servicesRepository.create({
      name: input.name,
      description: input.description,
      price: input.price,
      estimatedDuration: input.estimatedDuration ?? 60,
      imageUrl: input.imageUrl,
      requiresQuote: input.requiresQuote ?? false,
      store: { id: input.storeId } as any,
      category: input.categoryId ? ({ id: input.categoryId } as any) : undefined,
    });

    const saved = await this.servicesRepository.save(service);
    return this.servicesRepository.findOneOrFail({ where: { id: saved.id }, relations: ['category', 'store'] });
  }

  async update(input: UpdateServiceInput, owner: any): Promise<Service> {
    const service = await this.servicesRepository.findOne({
      where: { id: input.id },
      relations: ['store', 'store.owner', 'category'],
    });
    if (!service) throw new NotFoundException('Servico nao encontrado');
    if (service.store?.owner?.id !== owner.id) {
      throw new BadRequestException('Voce nao tem permissao para editar este servico.');
    }

    if (input.name !== undefined) service.name = input.name;
    if (input.description !== undefined) service.description = input.description;
    if (input.price !== undefined) service.price = input.price;
    if (input.estimatedDuration !== undefined) service.estimatedDuration = input.estimatedDuration;
    if (input.imageUrl !== undefined) service.imageUrl = input.imageUrl;
    if (input.requiresQuote !== undefined) service.requiresQuote = input.requiresQuote;
    if (input.isAvailable !== undefined) service.isAvailable = input.isAvailable;
    if (input.isActive !== undefined) service.isActive = input.isActive;
    if (input.categoryId !== undefined) {
      service.category = input.categoryId ? ({ id: input.categoryId } as any) : null;
    }

    return this.servicesRepository.save(service);
  }

  async delete(id: string, owner: any): Promise<boolean> {
    const service = await this.servicesRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner'],
    });
    if (!service) throw new NotFoundException('Servico nao encontrado');
    if (service.store?.owner?.id !== owner.id) {
      throw new BadRequestException('Voce nao tem permissao para excluir este servico.');
    }

    await this.servicesRepository.remove(service);
    return true;
  }

  async findByStore(storeId: string, includeAll = false): Promise<Service[]> {
    const where: any = { store: { id: storeId } };
    if (!includeAll) {
      where.isActive = true;
      where.isAvailable = true;
    }
    return this.servicesRepository.find({
      where,
      relations: ['category'],
      order: { name: 'ASC' },
    });
  }

  async findById(id: string): Promise<Service> {
    const service = await this.servicesRepository.findOne({
      where: { id },
      relations: ['store', 'category'],
    });
    if (!service) throw new NotFoundException('Servico nao encontrado');
    return service;
  }

  async searchPublic(query: string, limit = 20): Promise<Service[]> {
    if (!query.trim()) return [];

    const terms = query.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);

    const qb = this.servicesRepository
      .createQueryBuilder('service')
      .leftJoinAndSelect('service.store', 'store')
      .leftJoinAndSelect('service.category', 'category')
      .where('store.isActive = :active', { active: true })
      .andWhere('service.isAvailable = :available', { available: true })
      .andWhere('service.isActive = :isActive', { isActive: true });

    if (terms.length === 1) {
      qb.andWhere(
        '(LOWER(service.name) LIKE :q OR LOWER(service.description) LIKE :q OR LOWER(category.name) LIKE :q)',
        { q: `%${terms[0]}%` },
      );
    } else {
      const conditions = terms.map((t, i) =>
        `(LOWER(service.name) LIKE :t${i} OR LOWER(service.description) LIKE :t${i} OR LOWER(category.name) LIKE :t${i})`
      ).join(' OR ');
      const params: Record<string, string> = {};
      terms.forEach((t, i) => { params[`t${i}`] = `%${t}%`; });
      qb.andWhere(`(${conditions})`, params);
    }

    return qb.orderBy('service.name').limit(limit).getMany();
  }
}
