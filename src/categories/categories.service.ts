import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { Store } from '../stores/entities/store.entity';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Store)
    private storeRepository: Repository<Store>,
  ) {}

  // Sem estas checagens, qualquer VENDOR criava/editava/excluia categorias em
  // loja de terceiros (IDOR — KAN-212). Feito no service para nao depender do
  // StoresModule (evita dependencia circular).
  private async assertOwnsStore(storeId: string | undefined, userId: string): Promise<void> {
    if (!storeId) throw new BadRequestException('Loja nao encontrada.');
    const store = await this.storeRepository.findOne({ where: { id: storeId }, relations: ['owner'] });
    if (!store) throw new BadRequestException('Loja nao encontrada.');
    if (store.owner?.id !== userId) {
      throw new BadRequestException('Voce nao tem permissao sobre esta loja.');
    }
  }

  private async loadOwnedCategory(id: string, userId: string): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner'],
    });
    if (!category) throw new NotFoundException('Categoria nao encontrada');
    if (category.store?.owner?.id !== userId) {
      throw new BadRequestException('Voce nao tem permissao sobre esta categoria.');
    }
    return category;
  }

  async create(name: string, storeId: string, requiresAgeVerification = false, userId?: string): Promise<Category> {
    if (userId) await this.assertOwnsStore(storeId, userId);
    const category = this.categoriesRepository.create({
      name,
      store: { id: storeId },
      requiresAgeVerification,
    });
    return this.categoriesRepository.save(category);
  }

  async update(id: string, data: { name?: string; requiresAgeVerification?: boolean }, userId?: string): Promise<Category> {
    const category = userId
      ? await this.loadOwnedCategory(id, userId)
      : await this.categoriesRepository.findOne({ where: { id } });
    if (!category) throw new NotFoundException('Categoria nao encontrada');
    if (data.name !== undefined) category.name = data.name;
    if (data.requiresAgeVerification !== undefined) category.requiresAgeVerification = data.requiresAgeVerification;
    return this.categoriesRepository.save(category);
  }

  async findByStore(storeId: string): Promise<Category[]> {
    return this.categoriesRepository.find({
      where: { store: { id: storeId }, isActive: true },
      order: { sortOrder: 'ASC' },
      relations: ['products'],
    });
  }

  async delete(id: string, userId?: string): Promise<boolean> {
    const category = userId
      ? await this.loadOwnedCategory(id, userId)
      : await this.categoriesRepository.findOne({ where: { id } });
    if (!category) throw new NotFoundException('Categoria nao encontrada');
    // Desvincula produtos da categoria antes de excluir
    await this.productsRepository.update({ category: { id } }, { category: null as any });
    await this.categoriesRepository.remove(category);
    return true;
  }
}
