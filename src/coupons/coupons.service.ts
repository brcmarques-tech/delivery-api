import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Coupon } from './entities/coupon.entity';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';
import { Store } from '../stores/entities/store.entity';
import { PlatformConfigService } from '../config/platform-config.service';

@Injectable()
export class CouponsService {
  constructor(
    @InjectRepository(Coupon)
    private couponsRepository: Repository<Coupon>,
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    private platformConfigService: PlatformConfigService,
  ) {}

  async create(input: CreateCouponInput, userId: string): Promise<Coupon> {
    const store = await this.storesRepository.findOne({
      where: { id: input.storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    if (store.owner.id !== userId) {
      throw new BadRequestException('Voce nao e dono desta loja');
    }

    // Check plan allows coupons
    const plan = store.owner.vendorPlan || 'FREE';
    const config = await this.platformConfigService.getPlanConfig(plan);
    if (!config.canUseCoupons) {
      throw new BadRequestException(
        'Seu plano nao permite criar cupons. Faca upgrade para PRO ou superior.',
      );
    }

    // Normalize code to uppercase
    const code = input.code.trim().toUpperCase();

    // Check unique code per store
    const existing = await this.couponsRepository.findOne({
      where: { code, store: { id: input.storeId } },
    });
    if (existing) {
      throw new BadRequestException('Ja existe um cupom com este codigo nesta loja');
    }

    if (input.discountType === 'PERCENT' && input.discountValue > 100) {
      throw new BadRequestException('Desconto percentual nao pode ser maior que 100%');
    }

    const coupon = this.couponsRepository.create({
      code,
      discountType: input.discountType,
      discountValue: input.discountValue,
      minimumOrder: input.minimumOrder,
      maxDiscount: input.maxDiscount,
      maxUses: input.maxUses || 0,
      expiresAt: input.expiresAt,
      store,
    });

    return this.couponsRepository.save(coupon);
  }

  async update(input: UpdateCouponInput, userId: string): Promise<Coupon> {
    const coupon = await this.couponsRepository.findOne({
      where: { id: input.id },
      relations: ['store', 'store.owner'],
    });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    if (coupon.store.owner.id !== userId) {
      throw new BadRequestException('Voce nao e dono desta loja');
    }

    if (input.code) coupon.code = input.code.trim().toUpperCase();
    if (input.discountType) coupon.discountType = input.discountType;
    if (input.discountValue !== undefined) coupon.discountValue = input.discountValue;
    if (input.minimumOrder !== undefined) coupon.minimumOrder = input.minimumOrder;
    if (input.maxDiscount !== undefined) coupon.maxDiscount = input.maxDiscount;
    if (input.maxUses !== undefined) coupon.maxUses = input.maxUses;
    if (input.expiresAt !== undefined) coupon.expiresAt = input.expiresAt;

    return this.couponsRepository.save(coupon);
  }

  async toggleActive(id: string, userId: string): Promise<Coupon> {
    const coupon = await this.couponsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner'],
    });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    if (coupon.store.owner.id !== userId) {
      throw new BadRequestException('Voce nao e dono desta loja');
    }
    coupon.isActive = !coupon.isActive;
    return this.couponsRepository.save(coupon);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const coupon = await this.couponsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner'],
    });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    if (coupon.store.owner.id !== userId) {
      throw new BadRequestException('Voce nao e dono desta loja');
    }
    await this.couponsRepository.remove(coupon);
    return true;
  }

  async findByStore(storeId: string): Promise<Coupon[]> {
    return this.couponsRepository.find({
      where: { store: { id: storeId } },
      relations: ['store'],
      order: { createdAt: 'DESC' },
    });
  }

  // ─── Superadmin ───

  async findAll(): Promise<Coupon[]> {
    return this.couponsRepository.find({
      relations: ['store', 'store.owner'],
      order: { createdAt: 'DESC' },
    });
  }

  async adminToggle(id: string): Promise<Coupon> {
    const coupon = await this.couponsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner'],
    });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    coupon.isActive = !coupon.isActive;
    return this.couponsRepository.save(coupon);
  }

  async adminDelete(id: string): Promise<boolean> {
    const coupon = await this.couponsRepository.findOne({ where: { id } });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    await this.couponsRepository.remove(coupon);
    return true;
  }

  /** Validate and calculate discount for a coupon code at checkout */
  async validateAndCalculate(
    code: string,
    storeId: string,
    subtotal: number,
  ): Promise<{ coupon: Coupon; discount: number }> {
    const coupon = await this.couponsRepository.findOne({
      where: { code: code.trim().toUpperCase(), store: { id: storeId } },
      relations: ['store'],
    });

    if (!coupon) {
      throw new BadRequestException('Cupom nao encontrado');
    }

    if (!coupon.isActive) {
      throw new BadRequestException('Este cupom esta desativado');
    }

    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
      throw new BadRequestException('Este cupom expirou');
    }

    if (coupon.maxUses > 0 && coupon.usesCount >= coupon.maxUses) {
      throw new BadRequestException('Este cupom ja atingiu o limite de usos');
    }

    if (coupon.minimumOrder && subtotal < Number(coupon.minimumOrder)) {
      throw new BadRequestException(
        `Pedido minimo de R$ ${Number(coupon.minimumOrder).toFixed(2)} para usar este cupom`,
      );
    }

    let discount: number;
    if (coupon.discountType === 'PERCENT') {
      discount = Math.round((subtotal * Number(coupon.discountValue)) / 100 * 100) / 100;
      if (coupon.maxDiscount && discount > Number(coupon.maxDiscount)) {
        discount = Number(coupon.maxDiscount);
      }
    } else {
      discount = Number(coupon.discountValue);
    }

    // Discount cannot exceed subtotal
    if (discount > subtotal) {
      discount = subtotal;
    }

    return { coupon, discount };
  }

  /** Increment usage count after order is created */
  async incrementUsage(couponId: string): Promise<void> {
    await this.couponsRepository.increment({ id: couponId }, 'usesCount', 1);
  }
}
