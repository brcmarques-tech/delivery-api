import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { Product } from './entities/product.entity';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { PUB_SUB } from '../pubsub/pubsub.module';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  async create(input: CreateProductInput): Promise<Product> {
    const product = this.productsRepository.create({
      name: input.name,
      description: input.description,
      price: input.price,
      imageUrl: input.imageUrl,
      unit: input.unit,
      stock: input.stock ?? 0,
      store: { id: input.storeId } as any,
      category: input.categoryId ? ({ id: input.categoryId } as any) : undefined,
    });
    const saved = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: saved });
    return saved;
  }

  async findByStore(storeId: string): Promise<Product[]> {
    return this.productsRepository.find({
      where: { store: { id: storeId }, isActive: true },
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

  async delete(id: string): Promise<boolean> {
    const product = await this.findById(id);
    const storeId = product.store?.id;
    await this.productsRepository.remove(product);
    // Publish with the id so clients can remove it
    this.pubSub.publish('productDeleted', { productDeleted: { id, storeId } });
    return true;
  }
}
