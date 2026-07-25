import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CartItem } from './entities/cart-item.entity';
import { AddToCartInput } from './dto/add-to-cart.input';
import { UpdateCartItemInput } from './dto/update-cart-item.input';
import { Product } from '../products/entities/product.entity';

@Injectable()
export class CartService {
  constructor(
    @InjectRepository(CartItem)
    private cartItemRepo: Repository<CartItem>,
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
  ) {}

  async addToCart(input: AddToCartInput, customerId: string): Promise<CartItem> {
    const product = await this.productRepo.findOne({
      where: { id: input.productId },
      relations: ['store'],
    });

    if (!product) {
      throw new NotFoundException('Produto nao encontrado');
    }

    if (!product.isAvailable || !product.isActive) {
      throw new BadRequestException('Produto indisponivel');
    }

    // Se ja existe no carrinho, soma a quantidade
    const existing = await this.cartItemRepo.findOne({
      where: {
        customer: { id: customerId },
        product: { id: input.productId },
      },
      relations: ['customer', 'product', 'store'],
    });

    if (existing) {
      if (input.weightGrams !== undefined) {
        existing.weightGrams = input.weightGrams;
      } else {
        existing.quantity += input.quantity;
      }
      if (input.notes !== undefined) {
        existing.notes = input.notes;
      }
      return this.cartItemRepo.save(existing);
    }

    const cartItem = this.cartItemRepo.create({
      customer: { id: customerId } as any,
      product: { id: product.id } as any,
      store: { id: product.store.id } as any,
      quantity: input.quantity,
      notes: input.notes,
      weightGrams: input.weightGrams,
    });

    try {
      const saved = await this.cartItemRepo.save(cartItem);
      return this.findById(saved.id);
    } catch (err: any) {
      // Race de double-tap: outra request criou a mesma linha (unique
      // customer+product) entre o findOne acima e este save. Em vez de estourar
      // 500, recupera o item recém-criado e soma a quantidade, como no caminho
      // "ja existe".
      const code = err?.code || err?.driverError?.code;
      if (code === '23505') {
        const concurrent = await this.cartItemRepo.findOne({
          where: {
            customer: { id: customerId },
            product: { id: input.productId },
          },
          relations: ['customer', 'product', 'store'],
        });
        if (concurrent) {
          if (input.weightGrams !== undefined) {
            concurrent.weightGrams = input.weightGrams;
          } else {
            concurrent.quantity += input.quantity;
          }
          if (input.notes !== undefined) {
            concurrent.notes = input.notes;
          }
          return this.cartItemRepo.save(concurrent);
        }
      }
      throw err;
    }
  }

  async updateCartItem(input: UpdateCartItemInput, customerId: string): Promise<CartItem> {
    const item = await this.cartItemRepo.findOne({
      where: { id: input.cartItemId, customer: { id: customerId } },
      relations: ['customer', 'product', 'store'],
    });

    if (!item) {
      throw new NotFoundException('Item do carrinho nao encontrado');
    }

    // N4: se o produto foi soft-deletado enquanto estava no carrinho, a relation
    // vem null. `CartItem.product` é não-nulável no schema — retornar assim daria
    // 500. Dá um erro claro (o cliente deve remover o item) em vez de quebrar.
    if (!item.product) {
      throw new NotFoundException(
        'Este produto nao esta mais disponivel. Remova-o do carrinho.',
      );
    }

    if (input.quantity !== undefined) {
      item.quantity = input.quantity;
    }
    if (input.weightGrams !== undefined) {
      item.weightGrams = input.weightGrams;
    }
    if (input.notes !== undefined) {
      item.notes = input.notes;
    }

    return this.cartItemRepo.save(item);
  }

  async removeFromCart(cartItemId: string, customerId: string): Promise<boolean> {
    const item = await this.cartItemRepo.findOne({
      where: { id: cartItemId, customer: { id: customerId } },
    });

    if (!item) {
      throw new NotFoundException('Item do carrinho nao encontrado');
    }

    await this.cartItemRepo.remove(item);
    return true;
  }

  async clearCart(customerId: string): Promise<boolean> {
    await this.cartItemRepo.delete({ customer: { id: customerId } });
    return true;
  }

  async clearCartByStore(customerId: string, storeId: string): Promise<boolean> {
    await this.cartItemRepo.delete({
      customer: { id: customerId },
      store: { id: storeId },
    });
    return true;
  }

  async getMyCart(customerId: string): Promise<CartItem[]> {
    const items = await this.cartItemRepo.find({
      where: { customer: { id: customerId } },
      relations: ['product', 'product.store', 'store'],
      order: { createdAt: 'ASC' },
    });
    // Produto soft-deletado deixa o cart_item órfão (o CASCADE do FK não dispara
    // em soft-delete) e a relação volta null. Como CartItem.product é não-nullable
    // no schema GraphQL, a query inteira do carrinho quebrava com 500 assim que o
    // cliente pedia `product` — bastava um vendedor apagar um produto que estava
    // no carrinho de alguém. Filtra os órfãos para a tela do carrinho voltar a abrir.
    return items.filter((i) => i.product);
  }

  async getMyCartByStore(customerId: string, storeId: string): Promise<CartItem[]> {
    const items = await this.cartItemRepo.find({
      where: {
        customer: { id: customerId },
        store: { id: storeId },
      },
      relations: ['product', 'product.store', 'store'],
      order: { createdAt: 'ASC' },
    });
    return items.filter((i) => i.product);
  }

  async getStoreCartSummary(storeId: string): Promise<{ productId: string; productName: string; productImageUrl: string | null; totalPeople: number; totalQuantity: number }[]> {
    const results = await this.cartItemRepo
      .createQueryBuilder('ci')
      .select('ci.productId', 'productId')
      .addSelect('p.name', 'productName')
      .addSelect('p.imageUrl', 'productImageUrl')
      .addSelect('COUNT(DISTINCT ci.customerId)', 'totalPeople')
      .addSelect('SUM(ci.quantity)', 'totalQuantity')
      .innerJoin('ci.product', 'p')
      .where('ci.storeId = :storeId', { storeId })
      .groupBy('ci.productId')
      .addGroupBy('p.name')
      .addGroupBy('p.imageUrl')
      .orderBy('"totalPeople"', 'DESC')
      .getRawMany();

    return results.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      productImageUrl: r.productImageUrl || null,
      totalPeople: Number(r.totalPeople),
      totalQuantity: Number(r.totalQuantity),
    }));
  }

  private async findById(id: string): Promise<CartItem> {
    return this.cartItemRepo.findOneOrFail({
      where: { id },
      relations: ['customer', 'product', 'product.store', 'store'],
    });
  }
}
