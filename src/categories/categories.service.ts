import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './entities/category.entity';
import { Product } from '../products/entities/product.entity';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
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

  async delete(id: string): Promise<boolean> {
    const category = await this.categoriesRepository.findOne({ where: { id } });
    if (!category) throw new NotFoundException('Categoria nao encontrada');
    // Desvincula produtos da categoria antes de excluir
    await this.productsRepository.update({ category: { id } }, { category: null as any });
    await this.categoriesRepository.remove(category);
    return true;
  }
}
