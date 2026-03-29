import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { PubSub } from 'graphql-subscriptions';
import { firstValueFrom } from 'rxjs';
import { Product } from './entities/product.entity';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { BulkCreateProductsInput, BulkImportResult } from './dto/bulk-create-products.input';
import { BarcodeLookupResult } from './dto/barcode-lookup-result';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { Store } from '../stores/entities/store.entity';
import { PlatformConfigService } from '../config/platform-config.service';
import { VerificationService } from '../stores/verification.service';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Store)
    private storeRepository: Repository<Store>,
    @Inject(PUB_SUB) private pubSub: PubSub,
    private httpService: HttpService,
    private platformConfigService: PlatformConfigService,
    @Inject(forwardRef(() => VerificationService))
    private verificationService: VerificationService,
  ) {}

  private async checkProductLimit(storeId: string): Promise<void> {
    const store = await this.storeRepository.findOne({
      where: { id: storeId },
      relations: ['owner'],
    });
    if (!store?.owner) return;
    const plan = store.owner.vendorPlan || 'FREE';
    const config = await this.platformConfigService.getPlanConfig(plan);
    if (config.maxProductsPerStore === 0) return; // 0 = ilimitado
    const currentCount = await this.productsRepository.count({
      where: { store: { id: storeId }, isActive: true },
    });
    if (currentCount >= config.maxProductsPerStore) {
      throw new BadRequestException(
        `Limite de produtos atingido (${config.maxProductsPerStore}). Faca upgrade do seu plano para adicionar mais produtos.`,
      );
    }
  }

  async create(input: CreateProductInput): Promise<Product> {
    await this.checkProductLimit(input.storeId);
    const isVariableWeight = input.isVariableWeight ?? false;
    const unit = input.unit ?? (isVariableWeight ? 'kg' : undefined);
    const product = this.productsRepository.create({
      name: input.name,
      description: input.description,
      price: input.price,
      imageUrl: input.imageUrl,
      unit,
      stock: input.stock ?? 0,
      barcode: input.barcode,
      isVariableWeight,
      store: { id: input.storeId } as any,
      category: input.categoryId ? ({ id: input.categoryId } as any) : undefined,
    });
    const saved = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: saved });
    this.verificationService.onProductAdded(input.storeId).catch(() => {});
    return saved;
  }

  async findByStore(storeId: string): Promise<Product[]> {
    return this.productsRepository.find({
      where: { store: { id: storeId }, isActive: true },
      relations: ['category'],
    }) as Promise<Product[]>;
  }

  async findByStoreAll(storeId: string): Promise<Product[]> {
    return this.productsRepository.find({
      where: { store: { id: storeId } },
      relations: ['category'],
    }) as Promise<Product[]>;
  }

  async findById(id: string): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: ['store', 'category'],
    });
    if (!product) throw new NotFoundException('Produto nao encontrado');
    return product;
  }

  async update(input: UpdateProductInput): Promise<Product> {
    const product = await this.findById(input.id);
    if (input.name !== undefined) product.name = input.name;
    if (input.description !== undefined) product.description = input.description;
    if (input.price !== undefined) product.price = input.price;
    if (input.imageUrl !== undefined) product.imageUrl = input.imageUrl;
    if (input.unit !== undefined) product.unit = input.unit;
    if (input.categoryId !== undefined) {
      product.category = input.categoryId ? ({ id: input.categoryId } as any) : null;
    }
    if (input.stock !== undefined) product.stock = input.stock;
    if (input.barcode !== undefined) product.barcode = input.barcode;
    if (input.isVariableWeight !== undefined) product.isVariableWeight = input.isVariableWeight;
    const saved = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: saved });
    return saved;
  }

  async toggleAvailability(id: string): Promise<Product> {
    const product = await this.findById(id);
    product.isAvailable = !product.isAvailable;
    const saved = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: saved });
    return saved;
  }

  async toggleActive(id: string): Promise<Product> {
    const product = await this.findById(id);
    product.isActive = !product.isActive;
    if (!product.isActive) {
      product.isAvailable = false;
    }
    const saved = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: saved });
    return saved;
  }

  async decrementStock(id: string, quantity: number): Promise<void> {
    const product = await this.findById(id);
    if (product.stock < quantity) {
      throw new BadRequestException(
        `Estoque insuficiente para "${product.name}". Disponivel: ${product.stock}, solicitado: ${quantity}`,
      );
    }
    product.stock -= quantity;
    if (product.stock === 0) {
      product.isAvailable = false;
    }
    const savedProduct = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: savedProduct });
  }

  async restoreStock(id: string, quantity: number): Promise<void> {
    const product = await this.productsRepository.findOne({ where: { id } });
    if (!product) return;
    product.stock += quantity;
    if (product.stock > 0 && !product.isAvailable) {
      product.isAvailable = true;
    }
    const savedProduct = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: savedProduct });
  }

  async findDeletedByStore(storeId: string): Promise<Product[]> {
    return this.productsRepository
      .createQueryBuilder('product')
      .withDeleted()
      .leftJoinAndSelect('product.category', 'category')
      .where('product.storeId = :storeId', { storeId })
      .andWhere('product.deletedAt IS NOT NULL')
      .orderBy('product.deletedAt', 'DESC')
      .getMany();
  }

  async restore(id: string): Promise<Product> {
    await this.productsRepository.restore(id);
    const product = await this.productsRepository.findOne({ where: { id }, relations: ['store', 'category'] });
    if (!product) throw new NotFoundException('Produto nao encontrado');
    return product;
  }

  async delete(id: string): Promise<boolean> {
    const product = await this.findById(id);
    const storeId = product.store?.id;
    await this.productsRepository.softRemove(product);
    this.pubSub.publish('productDeleted', { productDeleted: { id, storeId } });
    return true;
  }

  async lookupBarcode(barcode: string): Promise<BarcodeLookupResult> {
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
    try {
      const { data } = await firstValueFrom(this.httpService.get(url));
      if (data.status !== 1 || !data.product) {
        return { barcode };
      }
      const p = data.product;
      return {
        barcode,
        name: p.product_name || p.product_name_pt || p.product_name_en,
        description: p.generic_name || p.generic_name_pt,
        imageUrl: p.image_front_url || p.image_url,
        brand: p.brands,
        quantity: p.quantity,
      };
    } catch {
      return { barcode };
    }
  }

  async searchPublic(query: string, limit = 20): Promise<Product[]> {
    if (!query.trim()) return [];

    const terms = query.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);

    const qb = this.productsRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.store', 'store')
      .leftJoinAndSelect('product.category', 'category')
      .where('store.isActive = :active', { active: true })
      .andWhere('product.isAvailable = :available', { available: true })
      .andWhere('product.isActive = :isActive', { isActive: true });

    if (terms.length === 1) {
      qb.andWhere(
        '(LOWER(product.name) LIKE :q OR LOWER(product.description) LIKE :q OR LOWER(category.name) LIKE :q)',
        { q: `%${terms[0]}%` },
      );
    } else {
      const conditions = terms.map((t, i) =>
        `(LOWER(product.name) LIKE :t${i} OR LOWER(product.description) LIKE :t${i} OR LOWER(category.name) LIKE :t${i})`
      ).join(' OR ');
      const params: Record<string, string> = {};
      terms.forEach((t, i) => { params[`t${i}`] = `%${t}%`; });
      qb.andWhere(`(${conditions})`, params);
    }

    return qb.orderBy('product.name').limit(limit).getMany();
  }

  async searchCatalog(query: string, limit = 20): Promise<Product[]> {
    if (!query.trim()) return [];

    // Get unique product IDs (one per name), preferring oldest entry (catalog)
    const uniqueIds = await this.productsRepository.query(
      `SELECT DISTINCT ON (LOWER(name)) id
       FROM products
       WHERE LOWER(name) LIKE $1 OR barcode = $2
       ORDER BY LOWER(name), "createdAt" ASC
       LIMIT $3`,
      [`%${query.toLowerCase()}%`, query.trim(), limit],
    );

    if (uniqueIds.length === 0) return [];

    const ids = uniqueIds.map((r: any) => r.id);

    return this.productsRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.store', 'store')
      .leftJoinAndSelect('product.category', 'category')
      .whereInIds(ids)
      .orderBy('product.name')
      .getMany();
  }

  async bulkCreate(input: BulkCreateProductsInput): Promise<BulkImportResult> {
    // Check limit before starting bulk import
    const store = await this.storeRepository.findOne({
      where: { id: input.storeId },
      relations: ['owner'],
    });
    const plan = store?.owner?.vendorPlan || 'FREE';
    const config = await this.platformConfigService.getPlanConfig(plan);
    const currentCount = await this.productsRepository.count({
      where: { store: { id: input.storeId }, isActive: true },
    });
    const maxAllowed = config.maxProductsPerStore === 0 ? Infinity : config.maxProductsPerStore;
    const slotsLeft = maxAllowed - currentCount;

    if (slotsLeft <= 0 && config.maxProductsPerStore > 0) {
      return {
        created: 0,
        errors: [`Limite de produtos atingido (${config.maxProductsPerStore}). Faca upgrade do seu plano.`],
      };
    }

    let created = 0;
    const errors: string[] = [];

    for (let i = 0; i < input.products.length; i++) {
      if (created >= slotsLeft) {
        errors.push(`Linha ${i + 1} (${input.products[i].name}): Limite de produtos atingido (${config.maxProductsPerStore})`);
        continue;
      }
      const item = input.products[i];
      try {
        const itemIsVariableWeight = item.isVariableWeight ?? false;
        const itemUnit = item.unit ?? (itemIsVariableWeight ? 'kg' : undefined);
        const product = this.productsRepository.create({
          name: item.name,
          description: item.description,
          price: item.price,
          imageUrl: item.imageUrl,
          unit: itemUnit,
          stock: item.stock ?? 0,
          barcode: item.barcode,
          isVariableWeight: itemIsVariableWeight,
          store: { id: input.storeId } as any,
          category: item.categoryId ? ({ id: item.categoryId } as any) : undefined,
        });
        await this.productsRepository.save(product);
        created++;
      } catch (err) {
        errors.push(`Linha ${i + 1} (${item.name}): ${err.message}`);
      }
    }

    return { created, errors };
  }
}
