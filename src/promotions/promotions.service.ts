import { Injectable, NotFoundException, BadRequestException, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, LessThan, MoreThan } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { Promotion } from './entities/promotion.entity';
import { CreatePromotionInput } from './dto/create-promotion.input';
import { StoresService } from '../stores/stores.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { Product } from '../products/entities/product.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
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
    private whatsAppService: WhatsAppService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  onModuleInit() {
    // KAN-253: as duas chamadas descartavam a Promise. Se algo escapar do
    // try/catch interno vira unhandled rejection — e a primeira roda no boot,
    // onde uma falha nao tratada e ainda mais sensivel.
    const run = () => {
      this.clearExpiredPromotions().catch((err) =>
        this.logger.error('clearExpiredPromotions falhou:', err),
      );
      // Contraparte da limpeza: aplica o desconto das promocoes pagas cuja
      // janela ja comecou (ate agora nada fazia isso — ver activateDuePromotions).
      this.activateDuePromotions().catch((err) =>
        this.logger.error('activateDuePromotions falhou:', err),
      );
    };
    run();
    setInterval(run, 5 * 60 * 1000);
  }

  /**
   * Broadcast de promoção SEM dados sensíveis do vendedor. O canal público
   * promotionUpdated era assinado por qualquer um e carregava checkoutUrl (link
   * de pagamento Pagar.me) e adCost (gasto com anúncio). O vendedor recebe o
   * checkoutUrl na resposta da própria mutation; o feed de clientes não precisa.
   * checkoutUrl é nullable; adCost é não-nullable, então vai zerado (não null).
   */
  private publishPromotionUpdate(saved: Promotion) {
    this.pubSub.publish('promotionUpdated', {
      promotionUpdated: { ...saved, checkoutUrl: null, adCost: 0 },
    });
  }

  // BUGFIX: existia apenas a limpeza de promocoes VENCIDAS — nada nunca ATIVAVA
  // uma promocao paga cuja janela comeca no futuro. O vendedor pagava por uma
  // campanha para segunda-feira, o webhook aplicava o desconto so se `now` ja
  // estivesse dentro da janela (nao estava), e na segunda ninguem reaplicava:
  // o produto seguia com preco cheio e a campanha paga simplesmente nao rodava.
  private async activateDuePromotions() {
    try {
      await this.productsRepository.manager.query(`
        UPDATE products p
        SET "promotionalPrice" = pr."promotionalPrice"
        FROM promotions pr
        WHERE pr."productId" = p.id
          AND pr."isPaid" = true
          AND pr."isActive" = true
          AND pr."startDate" <= NOW()
          AND pr."endDate" >= NOW()
          AND pr."promotionalPrice" IS NOT NULL
          AND (p."promotionalPrice" IS DISTINCT FROM pr."promotionalPrice")
      `);
    } catch (err) {
      this.logger.error('Error activating due promotions', err);
    }
  }

  private async clearExpiredPromotions() {
    try {
      await this.productsRepository.manager.query(`
        UPDATE products p
        SET "promotionalPrice" = NULL
        FROM promotions pr
        WHERE pr."productId" = p.id
          AND pr."endDate" < NOW()
          AND p."promotionalPrice" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM promotions pr2
            WHERE pr2."productId" = p.id
              AND pr2."endDate" >= NOW()
              AND pr2."isPaid" = true
          )
      `);
    } catch (err) {
      this.logger.error('Error clearing expired promotions', err);
    }
  }

  async create(input: CreatePromotionInput, user: VendorUser): Promise<Promotion> {
    const store = await this.storesService.findById(input.storeId);
    if (store.owner.id !== user.id) {
      throw new BadRequestException('Voce nao e o dono dessa loja.');
    }

    const hasBadgeCredit = store.freePromoDaysCredit > 0;
    const planConfig = await this.platformConfigService.getPlanConfig(user.vendorPlan || 'FREE');

    if (!hasBadgeCredit) {
      if (planConfig.freePromosPerWeek <= 0) {
        throw new BadRequestException(
          'Seu plano nao permite criar promocoes. Faca upgrade para o plano Pro ou superior.',
        );
      }

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

    const pricePerDay = await this.platformConfigService.getPromoPricePerDay();
    const start = new Date(input.startDate);
    const end = new Date(input.endDate);
    const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

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

    // BUGFIX: `create` nao validava a faixa do preco promocional (so @Min(0) no
    // DTO), enquanto `swapProduct` ja exigia ser menor que o preco do produto.
    // Sem isto dava para criar promocao com preco ACIMA do normal — e o pedido
    // usa `promotionalPrice || price`, entao a "promocao" cobrava MAIS caro do
    // cliente. E o 0 permitido virava produto de graca (subtotal e comissao 0).
    if (product && input.promotionalPrice !== undefined && input.promotionalPrice !== null) {
      if (Number(input.promotionalPrice) <= 0) {
        throw new BadRequestException('O preco promocional deve ser maior que zero.');
      }
      if (Number(input.promotionalPrice) >= Number(product.price)) {
        throw new BadRequestException(
          'O preco promocional deve ser menor que o preco atual do produto.',
        );
      }
    }

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
    this.publishPromotionUpdate(saved);

    if (usedFreeDays > 0) {
      // R#6: decremento ATÔMICO do crédito de dias grátis. ANTES era um
      // read-modify-write (`saveStore`) sem lock: duas promoções simultâneas liam
      // o mesmo saldo e o last-write-wins descontava o crédito uma única vez para
      // as duas. Agora o UPDATE aplica os dois decrementos de fato (clampando em 0).
      // (Resíduo: se ambas quiserem MAIS dias grátis do que o saldo total no mesmo
      // instante, ainda pode haver leve sobre-concessão; travar 100% exige um claim
      // do saldo antes de calcular `usedFreeDays`.)
      await this.productsRepository.manager.query(
        `UPDATE stores SET "freePromoDaysCredit" = GREATEST("freePromoDaysCredit" - $2, 0) WHERE id = $1`,
        [store.id, usedFreeDays],
      );
    }

    if (user.phone) {
      this.whatsAppService.notifyPromotionCreated(
        user.phone,
        store.name,
        input.title,
        adCost.toFixed(2),
      ).catch(() => {});
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
    const promotion = await this.promotionsRepository.findOne({
      where: { id },
      relations: ['product'],
    });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    promotion.isActive = !promotion.isActive;
    const saved = await this.promotionsRepository.save(promotion);

    // BL#4: manter o preço promocional do produto em sincronia com o estado da
    // promoção. ANTES, desativar uma promoção PAGA não removia o
    // `promotionalPrice` do produto — o desconto continuava valendo em CADA novo
    // pedido até a data de fim (o pricing lê `product.promotionalPrice` direto,
    // sem checar `isActive`). Agora ao desativar limpamos; ao reativar dentro da
    // vigência reaplicamos (mesmo padrão de delete/swapProduct/markAsPaid).
    if (promotion.isPaid && promotion.product && promotion.promotionalPrice) {
      if (!promotion.isActive) {
        await this.productsRepository.update(promotion.product.id, { promotionalPrice: null as any });
      } else {
        const now = new Date();
        if (now >= new Date(promotion.startDate) && now <= new Date(promotion.endDate)) {
          await this.productsRepository.update(promotion.product.id, {
            promotionalPrice: promotion.promotionalPrice,
          });
        }
      }
    }

    this.publishPromotionUpdate(saved);
    return saved;
  }

  async markAsPaid(id: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findOne({
      where: { id },
      relations: ['product', 'product.store', 'store', 'store.owner'],
    });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    promotion.isPaid = true;
    const saved = await this.promotionsRepository.save(promotion);
    this.publishPromotionUpdate(saved);

    if (promotion.store?.owner?.phone) {
      this.whatsAppService.notifyPromotionPaid(promotion.store.owner.phone, promotion.title).catch(() => {});
    }

    if (promotion.product && promotion.promotionalPrice) {
      const now = new Date();
      const start = new Date(promotion.startDate);
      const end = new Date(promotion.endDate);
      if (now >= start && now <= end) {
        await this.productsRepository.update(promotion.product.id, {
          promotionalPrice: promotion.promotionalPrice,
        });
        this.logger.log(`Applied promotionalPrice ${promotion.promotionalPrice} to product ${promotion.product.id}`);
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
    if (promotion.product && promotion.isPaid) {
      await this.productsRepository.update(promotion.product.id, { promotionalPrice: null as any });
    }
    const product = await this.productsRepository.findOne({
      where: { id: productId, store: { id: promotion.store.id } },
    });
    if (!product) throw new NotFoundException('Produto nao encontrado nessa loja.');
    if (promotionalPrice >= Number(product.price)) {
      throw new BadRequestException('O preco promocional deve ser menor que o preco original do produto.');
    }
    promotion.product = product;
    promotion.promotionalPrice = promotionalPrice;
    promotion.title = title;
    if (product.imageUrl) promotion.imageUrl = product.imageUrl;
    const saved = await this.promotionsRepository.save(promotion);
    this.publishPromotionUpdate(saved);
    // BUGFIX: faltavam `isActive` e o inicio da janela. Consequencias: (a) promo
    // comprada para o futuro passava a valer NA HORA (dias de desconto nao
    // pagos); (b) depois de o superadmin DESATIVAR a promocao — o que limpa o
    // preco — bastava o vendedor trocar o produto para o desconto voltar,
    // furando a desativacao. Mesma condicao usada em toggleActive/markAsPaid.
    if (promotion.isPaid && promotion.isActive) {
      const now = new Date();
      const start = new Date(promotion.startDate);
      const end = new Date(promotion.endDate);
      if (now >= start && now <= end) {
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
    if (promotion.product && promotion.isPaid) {
      await this.productsRepository.update(promotion.product.id, { promotionalPrice: null as any });
    }
    await this.promotionsRepository.remove(promotion);
    return true;
  }
}
