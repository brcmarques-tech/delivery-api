import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { Promotion } from './entities/promotion.entity';
import { CreatePromotionInput } from './dto/create-promotion.input';
import { StoresService } from '../stores/stores.service';
import { User } from '../users/entities/user.entity';
import { getPlanConfig } from '../common/plan-config';

@Injectable()
export class PromotionsService {
  constructor(
    @InjectRepository(Promotion)
    private promotionsRepository: Repository<Promotion>,
    private storesService: StoresService,
  ) {}

  async create(input: CreatePromotionInput, user: User): Promise<Promotion> {
    const planConfig = getPlanConfig(user.vendorPlan);
    if (!planConfig.canPromote) {
      throw new BadRequestException(
        'Seu plano nao permite criar promocoes. Faca upgrade para o plano Pro ou Premium.',
      );
    }

    const store = await this.storesService.findById(input.storeId);
    if (store.owner.id !== user.id) {
      throw new BadRequestException('Voce nao e o dono dessa loja.');
    }

    const promotion = this.promotionsRepository.create({
      ...input,
      store,
    });
    return this.promotionsRepository.save(promotion);
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
      relations: ['store'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByStore(storeId: string): Promise<Promotion[]> {
    return this.promotionsRepository.find({
      where: { store: { id: storeId } },
      relations: ['store'],
      order: { createdAt: 'DESC' },
    });
  }

  async findAll(): Promise<Promotion[]> {
    return this.promotionsRepository.find({
      relations: ['store', 'store.owner'],
      order: { createdAt: 'DESC' },
    });
  }

  async toggleActive(id: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findOne({ where: { id } });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    promotion.isActive = !promotion.isActive;
    return this.promotionsRepository.save(promotion);
  }

  async markAsPaid(id: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findOne({ where: { id } });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    promotion.isPaid = true;
    return this.promotionsRepository.save(promotion);
  }
}
