import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
  ) {}

  async create(input: CreateProductInput): Promise<Product> {
    const product = this.productsRepository.create({
      name: input.name,
      description: input.description,
      price: input.price,
      imageUrl: input.imageUrl,
      unit: input.unit,
      store: { id: input.storeId } as any,
      category: input.categoryId ? ({ id: input.categoryId } as any) : undefined,
    });
    return this.productsRepository.save(product);
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
    return this.productsRepository.save(product);
  }

  async toggleAvailability(id: string): Promise<Product> {
    const product = await this.findById(id);
    product.isAvailable = !product.isAvailable;
    return this.productsRepository.save(product);
  }

  async delete(id: string): Promise<boolean> {
    const product = await this.findById(id);
    await this.productsRepository.remove(product);
    return true;
  }
}
