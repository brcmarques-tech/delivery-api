import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './entities/category.entity';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
  ) {}

  async create(name: string, storeId: string): Promise<Category> {
    const category = this.categoriesRepository.create({
      name,
      store: { id: storeId },
    });
    return this.categoriesRepository.save(category);
  }

  async findByStore(storeId: string): Promise<Category[]> {
    return this.categoriesRepository.find({
      where: { store: { id: storeId }, isActive: true },
      order: { sortOrder: 'ASC' },
      relations: ['products'],
    });
  }
}
