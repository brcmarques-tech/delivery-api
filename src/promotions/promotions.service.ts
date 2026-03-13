import { Injectable, NotFoundException, BadRequestException, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, LessThan, MoreThan } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { Promotion } from './entities/promotion.entity';
import { CreatePromotionInput } from './dto/create-promotion.input';
import { StoresService } from '../stores/stores.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { PUB_SUB } from '../pubsub/pubsub.module';

@Injectable()
export class PromotionsService implements OnModuleInit {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(
    @InjectRepository(Promotion)
    private promotionsRepository: Repository<Promotion>,
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    private storesService: StoresService,
    private platformConfigService: PlatformConfigService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  onModuleInit() {
    // Check for expired promotions every 30 minutes
    setInterval(() => this.clearExpiredPromotions(), 30 * 60 * 1000);
    // Also run on startup
    this.clearExpiredPromotions();
  }

  private async clearExpiredPromotions() {
    try {
      const now = new Date();
      const expired = await this.promotionsRepository.find({
        where: {
          isPaid: true,
          endDate: LessThan(now),
        },
        relations: ['product'],
      });
      for (const promo of expired) {
        if (promo.product?.promotionalPrice) {
          await this.productsRepository.update(promo.product.id, { promotionalPrice: null as any });
          this.pubSub.publish('productUpdated', { productUpdated: { ...promo.product, promotionalPrice: null } });
        }
      }
      if (expired.length > 0) {
        this.logger.log(`Cleared promotional prices from ${expired.length} expired promotions`);
      }
    } catch (err) {
      this.logger.error('Error clearing expired promotions', err);
    }
  }

  async create(input: CreatePromotionInput, user: User): Promise<Promotion> {
    const store = await this.storesService.findById(input.storeId);
    if (store.owner.id !== user.id) {
      throw new BadRequestException('Voce nao e o dono dessa loja.');
    }

    const hasBadgeCredit = store.freePromoDaysCredit > 0;
    const planConfig = await this.platformConfigService.getPlanConfig(user.vendorPlan || 'FREE');

    // Skip plan restriction if store has badge free promo days credit
    if (!hasBadgeCredit) {
      if (planConfig.freePromosPerWeek <= 0) {
        throw new BadRequestException(
          'Seu plano nao permite criar promocoes. Faca upgrade para o plano Pro ou superior.',
        );
      }

      // Count promotions created this week by this user
      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);

      const promosThisWeek = await this.promotionsRepository.count({
        where: {
          store: { owner: { id: user.id } },
          createdAt: MoreThan(startOfWeek),
        },
      });

      if (promosThisWeek >= planConfig.freePromosPerWeek) {
        throw new BadRequestException(
          `Seu plano permite no maximo ${planConfig.freePromosPerWeek} promocao(oes) por semana. Faca upgrade para criar mais.`,
        );
      }
    }

    let product: Product | null = null;
    if (input.productId) {
      product = await this.productsRepository.findOne({
        where: { id: input.productId, store: { id: input.storeId } },
      });
      if (!product) throw new NotFoundException('Produto nao encontrado');
    }

    // Calculate ad cost with discount
    const pricePerDay = await this.platformConfigService.getPromoPricePerDay();
    const start = new Date(input.startDate);
    const end = new Date(input.endDate);
    const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

    // Apply badge free promo days credit
    let paidDays = totalDays;
    let usedFreeDays = 0;
    if (store.freePromoDaysCredit > 0) {
      usedFreeDays = Math.min(store.freePromoDaysCredit, totalDays);
      paidDays = totalDays - usedFreeDays;
    }

    let discount = 0;
    if (paidDays >= 365) discount = 0.30;
    else if (paidDays >= 30) discount = 0.20;
    else if (paidDays >= 7) discount = 0.10;
    const adCost = paidDays > 0 ? paidDays * pricePerDay * (1 - discount) : 0;

    const promotion = new Promotion();
    promotion.title = input.title;
    if (input.description) promotion.description = input.description;
    const imgUrl = product?.imageUrl || input.imageUrl;
    if (imgUrl) promotion.imageUrl = imgUrl;
    promotion.startDate = input.startDate;
    promotion.endDate = input.endDate;
    promotion.promotionalPrice = input.promotionalPrice;
    promotion.adCost = adCost;
    promotion.store = store;
    if (product) promotion.product = product;
    const saved = await this.promotionsRepository.save(promotion);
    this.pubSub.publish('promotionUpdated', { promotionUpdated: saved });

    // Deduct used free promo days from store credit
    if (usedFreeDays > 0) {
      store.freePromoDaysCredit = Math.max(0, store.freePromoDaysCredit - usedFreeDays);
      await this.storesService.saveStore(store);
    }

    return saved;
  }

  async saveCheckoutUrl(id: string, checkoutUrl: string): Promise<void> {
    await this.promotionsRepository.update(id, { checkoutUrl });
  }

  async findActive(): Promise<Promotion[]> {
    const now = new Date();
    return this.promotionsRepository.find({
      where: {
        isActive: true,
        isPaid: true,
        startDate: LessThanOrEqual(now),
        endDate: MoreThanOrEqual(now),
      },
      relations: ['store', 'product'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByOwner(ownerId: string): Promise<Promotion[]> {
    return this.promotionsRepository.find({
      where: { store: { owner: { id: ownerId } } },
      relations: ['store', 'product'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByStore(storeId: string): Promise<Promotion[]> {
    return this.promotionsRepository.find({
      where: { store: { id: storeId } },
      relations: ['store', 'product'],
      order: { createdAt: 'DESC' },
    });
  }

  async findAll(): Promise<Promotion[]> {
    return this.promotionsRepository.find({
      relations: ['store', 'store.owner', 'product'],
      order: { createdAt: 'DESC' },
    });
  }

  async toggleActive(id: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findOne({ where: { id } });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    promotion.isActive = !promotion.isActive;
    const saved = await this.promotionsRepository.save(promotion);
    this.pubSub.publish('promotionUpdated', { promotionUpdated: saved });
    return saved;
  }

  async markAsPaid(id: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findOne({
      where: { id },
      relations: ['product', 'product.store', 'store'],
    });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    promotion.isPaid = true;
    const saved = await this.promotionsRepository.save(promotion);
    this.pubSub.publish('promotionUpdated', { promotionUpdated: saved });
    // Apply promotional price to the product
    if (promotion.product && promotion.promotionalPrice) {
      const now = new Date();
      const start = new Date(promotion.startDate);
      const end = new Date(promotion.endDate);
      if (now >= start && now <= end) {
        await this.productsRepository.update(promotion.product.id, {
          promotionalPrice: promotion.promotionalPrice,
        });
        this.logger.log(`Applied promotionalPrice ${promotion.promotionalPrice} to product ${promotion.product.id}`);
        // Notify subscribers so store page refreshes immediately
        const updatedProduct = await this.productsRepository.findOne({
          where: { id: promotion.product.id },
          relations: ['category', 'store'],
        });
        if (updatedProduct) {
          this.pubSub.publish('productUpdated', { productUpdated: updatedProduct });
        }
      }
    }
    return saved;
  }

  async swapProduct(id: string, productId: string, promotionalPrice: number, title: string, userId: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner', 'product'],
    });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    if (promotion.store.owner.id !== userId) {
      throw new BadRequestException('Voce nao e o dono dessa promocao.');
    }
    // Clear old product's promotional price
    if (promotion.product && promotion.isPaid) {
      await this.productsRepository.update(promotion.product.id, { promotionalPrice: null as any });
    }
    const product = await this.productsRepository.findOne({
      where: { id: productId, store: { id: promotion.store.id } },
    });
    if (!product) throw new NotFoundException('Produto nao encontrado nessa loja.');
    promotion.product = product;
    promotion.promotionalPrice = promotionalPrice;
    promotion.title = title;
    if (product.imageUrl) promotion.imageUrl = product.imageUrl;
    const saved = await this.promotionsRepository.save(promotion);
    this.pubSub.publish('promotionUpdated', { promotionUpdated: saved });
    // Apply new promotional price if promotion is active
    if (promotion.isPaid) {
      const now = new Date();
      const end = new Date(promotion.endDate);
      if (now <= end) {
        await this.productsRepository.update(product.id, { promotionalPrice });
      }
    }
    return saved;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const promotion = await this.promotionsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner', 'product'],
    });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    if (promotion.store.owner.id !== userId) {
      throw new BadRequestException('Voce nao e o dono dessa promocao.');
    }
    // Clear product's promotional price
    if (promotion.product && promotion.isPaid) {
      await this.productsRepository.update(promotion.product.id, { promotionalPrice: null as any });
    }
    await this.promotionsRepository.remove(promotion);
    return true;
  }
}
