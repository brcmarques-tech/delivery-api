import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Logger,
  Inject,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Store } from './entities/store.entity';
import { Product } from '../products/entities/product.entity';
import { StoreFollow } from './entities/store-follow.entity';
import { CreateStoreInput } from './dto/create-store.input';
import { UpdateStoreInput } from './dto/update-store.input';
import {
  StorefrontResult,
  StorefrontCategory,
  StorefrontProduct,
  PublicStoreCard,
} from './dto/storefront-result';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { PlatformConfigService } from '../config/platform-config.service';
import { MailService } from '../mail/mail.service';
import { peppered } from '../common/utils/pepper';
import { businessToday } from '../common/utils/business-time';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { RatingsService } from '../ratings/ratings.service';
import { fetchWithTimeout } from '../common/utils/fetch-with-timeout'; // KAN-253
import { resolvePublicUrl } from '../common/utils/public-url';

@Injectable()
export class StoresService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StoresService.name);

  constructor(
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    @InjectRepository(StoreFollow)
    private storeFollowRepository: Repository<StoreFollow>,
    @InjectRepository(AppUser)
    private appUsersRepository: Repository<AppUser>,
    @InjectRepository(VendorUser)
    private vendorUsersRepository: Repository<VendorUser>,
    private platformConfigService: PlatformConfigService,
    private mailService: MailService,
    private whatsAppService: WhatsAppService,
    private configService: ConfigService,
    @Inject(PUB_SUB) private pubSub: PubSub,
    private ratingsService: RatingsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.backfillSlugs();
  }

  generateSlug(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 50);
  }

  async ensureUniqueSlug(base: string, excludeId?: string): Promise<string> {
    let slug = base;
    let counter = 2;
    while (true) {
      const existing = await this.storesRepository.findOne({ where: { slug } });
      if (!existing || existing.id === excludeId) return slug;
      slug = `${base}-${counter++}`;
    }
  }

  async findBySlug(slug: string): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { slug },
      relations: [
        'owner',
        'products',
        'products.category',
        'categories',
        'services',
        'services.category',
      ],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    return store;
  }

  async backfillSlugs(): Promise<void> {
    const stores = await this.storesRepository.find({
      where: { slug: null as any },
    });
    for (const store of stores) {
      const base = this.generateSlug(store.name);
      store.slug = await this.ensureUniqueSlug(base, store.id);
      await this.storesRepository.save(store);
    }
    if (stores.length > 0) {
      this.logger.log(`Backfill: ${stores.length} loja(s) receberam slug`);
    }
  }

  async getPublicStorefront(
    storeId?: string,
    slug?: string,
  ): Promise<StorefrontResult> {
    if (!storeId && !slug) {
      throw new BadRequestException('Informe storeId ou slug');
    }

    const store = slug
      ? await this.storesRepository.findOne({
          where: { slug },
          relations: ['categories', 'categories.products'],
        })
      : await this.storesRepository.findOne({
          where: { id: storeId },
          relations: ['categories', 'categories.products'],
        });

    if (!store) throw new NotFoundException('Loja nao encontrada');
    // BUGFIX: `isActive` era filtrado apenas na LISTAGEM. Uma loja desativada
    // (fraude, inadimplencia, encerramento) sumia da home mas continuava
    // servindo o catalogo inteiro pelo link direto /loja/<slug> — ja
    // compartilhado no Instagram/WhatsApp — e os pedidos eram aceitos.
    if (!store.isActive) throw new NotFoundException('Loja nao encontrada');

    const [avgRating, totalRatings] = await Promise.all([
      this.ratingsService.averageStoreRating(store.id),
      this.ratingsService.totalStoreRatings(store.id),
    ]);

    const categories: StorefrontCategory[] = (store.categories || [])
      .filter((c) => c.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        id: c.id,
        name: c.name,
        imageUrl: c.imageUrl,
        sortOrder: c.sortOrder,
        requiresAgeVerification: c.requiresAgeVerification,
        products: (c.products || [])
          .filter((p) => p.isAvailable && p.isActive && !p.deletedAt)
          .map(
            (p): StorefrontProduct => ({
              id: p.id,
              name: p.name,
              description: p.description,
              price: Number(p.price),
              promotionalPrice: p.promotionalPrice
                ? Number(p.promotionalPrice)
                : undefined,
              imageUrl: p.imageUrl,
              isAvailable: p.isAvailable,
              stock: p.stock,
              unit: p.unit,
              isVariableWeight: p.isVariableWeight,
            }),
          ),
      }));

    return {
      id: store.id,
      slug: store.slug,
      name: store.name,
      description: store.description,
      logoUrl: store.logoUrl,
      bannerUrl: store.bannerUrl,
      phone: store.phone,
      street: store.street,
      number: store.number,
      complement: store.complement,
      neighborhood: store.neighborhood,
      city: store.city,
      state: store.state,
      zipCode: store.zipCode,
      isOpen: store.isOpen,
      isActive: store.isActive,
      storeType: store.storeType,
      hasOwnDelivery: store.hasOwnDelivery,
      freeDelivery: store.freeDelivery,
      deliveryFee: Number(store.deliveryFee),
      estimatedDeliveryMinutes: store.estimatedDeliveryMinutes,
      minimumOrder: Number(store.minimumOrder),
      deliveryStartTime: store.deliveryStartTime,
      deliveryEndTime: store.deliveryEndTime,
      freeDeliveryAbove: store.freeDeliveryAbove
        ? Number(store.freeDeliveryAbove)
        : undefined,
      verificationLevel: store.verificationLevel,
      averageRating: avgRating,
      totalRatings,
      categories,
    };
  }

  async getPublicStores(): Promise<PublicStoreCard[]> {
    const stores = await this.storesRepository.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });

    // KAN-262: era 2 queries de rating POR loja dentro do Promise.all (N+1).
    // Agora sao 2 queries agregadas no total, independente do numero de lojas.
    const stats = await this.ratingsService.statsForStores(
      stores.map((s) => s.id),
    );

    return stores.map((store) => {
      const s = stats.get(store.id);
      return {
        id: store.id,
        slug: store.slug,
        name: store.name,
        description: store.description,
        logoUrl: store.logoUrl,
        bannerUrl: store.bannerUrl,
        city: store.city,
        state: store.state,
        isOpen: store.isOpen,
        storeType: store.storeType,
        deliveryFee: Number(store.deliveryFee),
        freeDelivery: store.freeDelivery,
        estimatedDeliveryMinutes: store.estimatedDeliveryMinutes,
        minimumOrder: Number(store.minimumOrder),
        verificationLevel: store.verificationLevel,
        averageRating: s?.average ?? 0,
        totalRatings: s?.total ?? 0,
      };
    });
  }

  private isInBrazil(lat: number, lng: number): boolean {
    return lat >= -34 && lat <= 6 && lng >= -74 && lng <= -34;
  }

  private async geocodeAddress(input: {
    street?: string;
    number?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
  }): Promise<{ latitude: number; longitude: number }> {
    const queries = [
      `${input.street}, ${input.number}, ${input.neighborhood}, ${input.city}, ${input.state}, Brazil`,
      `${input.street}, ${input.number}, ${input.city}, ${input.state}, Brazil`,
      `${input.street}, ${input.city}, ${input.state}, Brazil`,
      `${input.neighborhood}, ${input.city}, ${input.state}, Brazil`,
      `${input.city}, ${input.state}, Brazil`,
    ];

    for (const query of queries) {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
        const res = await fetchWithTimeout(url, {
          headers: { 'User-Agent': 'bcmTech-Shopping/1.0' },
        });
        const data = await res.json();
        if (data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lng = parseFloat(data[0].lon);
          if (this.isInBrazil(lat, lng)) {
            this.logger.log(
              `Geocoded with query: "${query}" -> ${lat}, ${lng}`,
            );
            return { latitude: lat, longitude: lng };
          }
          this.logger.warn(
            `Geocoding fora do Brasil para: "${query}" -> ${lat}, ${lng}`,
          );
        }
      } catch (err) {
        this.logger.warn(`Geocoding attempt failed for: ${query}`, err);
      }
    }

    throw new BadRequestException(
      'Nao foi possivel localizar o endereco. Verifique os dados e tente novamente.',
    );
  }

  async create(input: CreateStoreInput, owner: VendorUser): Promise<Store> {
    const planConfig = await this.platformConfigService.getPlanConfig(
      owner.vendorPlan || 'FREE',
    );
    const currentStores = await this.storesRepository.count({
      where: { owner: { id: owner.id } },
    });

    // BUGFIX: `0` significa ILIMITADO em maxProductsPerStore (products.service.ts
    // trata explicitamente), mas aqui era comparado direto — entao o plano
    // CUSTOM (`maxStores: 0`, a faixa "fale com vendas") deixava justamente o
    // cliente negociado SEM PODER CRIAR NENHUMA LOJA, com a mensagem "seu plano
    // permite no maximo 0 loja(s)". Semantica agora consistente.
    if (planConfig.maxStores > 0 && currentStores >= planConfig.maxStores) {
      throw new BadRequestException(
        `Seu plano permite no maximo ${planConfig.maxStores} loja(s). Faca upgrade para criar mais.`,
      );
    }

    if (!input.latitude || !input.longitude) {
      const coords = await this.geocodeAddress(input);
      input.latitude = coords.latitude;
      input.longitude = coords.longitude;
    }

    const store = this.storesRepository.create({ ...input, owner });
    const saved = await this.storesRepository.save(store);

    // Gerar slug após salvar (precisamos do id para garantir unicidade)
    const base = this.generateSlug(saved.name);
    saved.slug = await this.ensureUniqueSlug(base, saved.id);
    const withSlug = await this.storesRepository.save(saved);

    this.pubSub.publish('storeUpdated', { storeUpdated: withSlug });
    return withSlug;
  }

  private isWithinHighlightDays(highlightDaysPerMonth: number): boolean {
    if (highlightDaysPerMonth >= 30) return true;
    if (highlightDaysPerMonth <= 0) return false;
    // BUGFIX: `new Date().getDate()` usa o fuso do PROCESSO (UTC em producao),
    // entao a virada do mes — que decide se a loja ainda esta na janela de
    // destaque — acontecia as 21:00 BRT do dia anterior. Agora conta o dia no
    // fuso do negocio.
    const today = Number(businessToday().slice(-2));
    return today <= highlightDaysPerMonth;
  }

  // ATENCAO (decisao de negocio, NAO alterada aqui): com os valores padrao
  // atuais — FREE {prioridade 1, destaque 15d}, PRO {1, 30d},
  // PREMIUM {2, 15d}, ENTERPRISE {3, 30d} — a ordenacao fica invertida parte do
  // mes: do dia 16 em diante o PREMIUM (R$ 99,90) sai da janela de destaque e cai
  // para 0, enquanto o PRO (R$ 49,90) segue em 1 — ou seja, o plano mais barato
  // aparece ACIMA do mais caro. E do dia 1 ao 15 FREE e PRO empatam em 1, entao
  // a "prioridade na listagem" que o PRO anuncia nao existe na pratica.
  // Corrigir isso e mudar precificacao/beneficio de plano, entao fica para o
  // Bruno decidir os numeros (em common/plan-config.ts e platform-config.service.ts,
  // que estao duplicados e vao divergir).

  private async sortByPriority(stores: Store[]): Promise<Store[]> {
    const storesWithPriority = await Promise.all(
      stores.map(async (store) => {
        const plan = store.owner?.vendorPlan || 'FREE';
        const config = await this.platformConfigService.getPlanConfig(plan);
        const isHighlighted = this.isWithinHighlightDays(
          config.highlightDaysPerMonth,
        );
        const effectivePriority = isHighlighted ? config.listingPriority : 0;
        return { store, effectivePriority };
      }),
    );
    storesWithPriority.sort(
      (a, b) => b.effectivePriority - a.effectivePriority,
    );
    return storesWithPriority.map((s) => s.store);
  }

  async findAll(): Promise<Store[]> {
    const stores = await this.storesRepository.find({
      where: { isActive: true },
      relations: ['owner', 'categories'],
    });
    return this.sortByPriority(stores);
  }

  async findById(id: string): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { id },
      relations: [
        'owner',
        'products',
        'products.category',
        'categories',
        'services',
        'services.category',
      ],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    return store;
  }

  // Perf (F5): versao leve, SEM o grafo de catalogo. calculateDeliveryFee e
  // estimatedDeliveryTime (chamados no checkout do app a cada mudanca de
  // endereco) usavam o findById completo — baixavam todos os produtos +
  // servicos + categorias da loja so para ler latitude/longitude/hasOwnDelivery.
  async findByIdBasic(id: string): Promise<Store> {
    const store = await this.storesRepository.findOne({ where: { id } });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    return store;
  }

  // Perf (F5/F6): catalogo paginado da loja para o app. O `store(id)` carrega
  // TODOS os produtos de uma vez (loja PREMIUM sem teto = milhares de itens num
  // JSON so). O app agora busca por paginas e a busca interna roda no servidor
  // (cobre o catalogo inteiro, nao so o que ja desceu). Soft-deleted (lixeira)
  // ficam fora automaticamente pelo @DeleteDateColumn.
  async findStoreProducts(
    storeId: string,
    limit = 100,
    offset = 0,
    search?: string,
    categoryId?: string,
  ): Promise<Product[]> {
    const qb = this.storesRepository.manager
      .getRepository(Product)
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.category', 'category')
      .where('p."storeId" = :storeId', { storeId });
    const q = search?.trim();
    if (q) {
      qb.andWhere('(p.name ILIKE :q OR p.description ILIKE :q)', { q: `%${q}%` });
    }
    // UX: chips de categoria na tela da loja — filtro no SQL (indexado por
    // categoryId), funciona mesmo com catalogo gigante paginado.
    if (categoryId) {
      qb.andWhere('p."categoryId" = :categoryId', { categoryId });
    }
    return qb
      .orderBy('p.name', 'ASC')
      .take(Math.min(Math.max(limit ?? 100, 1), 200))
      .skip(Math.max(offset ?? 0, 0))
      .getMany();
  }

  async findByWhatsappNumber(number: string): Promise<Store | null> {
    // BUGFIX: o controller do n8n normaliza o telefone para so digitos
    // ("5553984424244") e aqui a comparacao era EXATA contra a coluna, que o
    // vendedor digita livre no painel ("+55 53 8442-4244"). Nunca casava — o
    // roteador do WhatsApp entao concluia "nao e vendedor" e mandava TODA
    // mensagem de vendedor para o agente do CLIENTE (ferramentas e prompt
    // errados) ou para a resposta de desconhecido. O agente do vendedor estava
    // inerte. O users/by-phone ja tinha sido corrigido assim; este ficou.
    const digits = (number || '').replace(/\D/g, '');
    if (!digits) return null;
    const semPais = digits.startsWith('55') ? digits.slice(2) : digits;
    return this.storesRepository
      .createQueryBuilder('s')
      .where("regexp_replace(s.\"whatsappNumber\", '[^0-9]', '', 'g') = :d", { d: digits })
      .orWhere("regexp_replace(s.\"whatsappNumber\", '[^0-9]', '', 'g') = :nc", { nc: semPais })
      .getOne();
  }

  async findByOwner(ownerId: string): Promise<Store[]> {
    return this.storesRepository.find({
      where: { owner: { id: ownerId } },
      relations: ['owner', 'products', 'products.category', 'categories'],
    });
  }

  async findNearby(
    lat: number,
    lng: number,
    radiusKm: number = 10,
  ): Promise<Store[]> {
    const stores = await this.storesRepository
      .createQueryBuilder('store')
      .leftJoinAndSelect('store.owner', 'owner')
      .where('store.isActive = :active', { active: true })
      .andWhere(
        `(6371 * acos(cos(radians(:lat)) * cos(radians(store.latitude)) * cos(radians(store.longitude) - radians(:lng)) + sin(radians(:lat)) * sin(radians(store.latitude)))) <= :radius`,
        { lat, lng, radius: radiusKm },
      )
      .getMany();
    return this.sortByPriority(stores);
  }

  async update(input: UpdateStoreInput, owner: VendorUser): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { id: input.id, owner: { id: owner.id } },
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    const { id, ...updates } = input;

    // Detecta se o endereço mudou
    const addressFields = [
      'street',
      'number',
      'neighborhood',
      'city',
      'state',
      'zipCode',
    ] as const;
    const addressChanged = addressFields.some(
      (f) => updates[f] !== undefined && updates[f] !== (store as any)[f],
    );

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) (store as any)[key] = value;
    });

    // Se coordenadas foram enviadas manualmente (do mapa), usar essas
    // Senão, recalcular via geocoding se o endereço mudou
    if (input.latitude && input.longitude) {
      store.latitude = input.latitude;
      store.longitude = input.longitude;
      this.logger.log(
        `Coordenadas definidas manualmente para loja ${store.name}: ${input.latitude}, ${input.longitude}`,
      );
    } else if (addressChanged && store.street && store.city && store.state) {
      try {
        const coords = await this.geocodeAddress(store);
        store.latitude = coords.latitude;
        store.longitude = coords.longitude;
        this.logger.log(
          `Coordenadas atualizadas para loja ${store.name}: ${coords.latitude}, ${coords.longitude}`,
        );
      } catch (err) {
        this.logger.warn(
          `Nao foi possivel recalcular coordenadas para loja ${store.name}`,
        );
      }
    }

    const saved = await this.storesRepository.save(store);
    this.pubSub.publish('storeUpdated', { storeUpdated: saved });
    return saved;
  }

  async toggleOpen(id: string, owner: VendorUser): Promise<Store> {
    const store = await this.storesRepository.findOne({
      where: { id, owner: { id: owner.id } },
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    store.isOpen = !store.isOpen;
    const saved = await this.storesRepository.save(store);
    this.pubSub.publish('storeUpdated', { storeUpdated: saved });
    return saved;
  }

  async findAllAdmin(): Promise<Store[]> {
    return this.storesRepository.find({
      relations: ['owner', 'products', 'products.category', 'categories'],
      order: { createdAt: 'DESC' },
    });
  }

  async toggleActive(id: string): Promise<Store> {
    const store = await this.storesRepository.findOne({ where: { id } });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    store.isActive = !store.isActive;
    const saved = await this.storesRepository.save(store);
    this.pubSub.publish('storeUpdated', { storeUpdated: saved });
    return saved;
  }

  async requestStoreDelete(
    storeId: string,
    adminId: string,
    password: string,
  ): Promise<boolean> {
    const admin = await this.appUsersRepository.findOne({
      where: { id: adminId },
    });
    if (!admin) throw new NotFoundException('Admin nao encontrado');

    const passwordValid = await bcrypt.compare(
      peppered(password),
      admin.password,
    );
    if (!passwordValid) throw new UnauthorizedException('Senha incorreta');

    const store = await this.storesRepository.findOne({
      where: { id: storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');

    const token = crypto.randomBytes(32).toString('hex');
    store.deleteToken = token;
    store.deleteTokenExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await this.storesRepository.save(store);

    // KAN-258 (mesma classe do fallback de API_URL nos frontends): este link vai
    // POR E-MAIL para o lojista. Se APP_URL nao estiver definida em producao, o
    // fallback antigo mandava um link para `localhost:3000` — inutil para quem
    // recebe. Agora avisa alto e usa o dominio publico.
    const apiUrl = resolvePublicUrl(this.configService, 'APP_URL', 'http://localhost:3000');
    const confirmUrl = `${apiUrl}/stores/confirm-delete?token=${token}`;

    const emailTo = admin.notificationEmail || admin.email;
    await this.mailService.sendStoreDeleteConfirmation(
      emailTo,
      admin.name,
      store.name,
      confirmUrl,
    );
    if (admin.phone) {
      this.whatsAppService
        .notifyStoreDeleteRequest(
          admin.phone,
          admin.name,
          store.name,
          confirmUrl,
        )
        .catch(() => {});
    }
    return true;
  }

  async requestVendorStoreDelete(
    storeId: string,
    vendorId: string,
    password: string,
  ): Promise<boolean> {
    const vendor = await this.vendorUsersRepository.findOne({
      where: { id: vendorId },
    });
    if (!vendor) throw new NotFoundException('Vendedor nao encontrado');

    const passwordValid = await bcrypt.compare(
      peppered(password),
      vendor.password,
    );
    if (!passwordValid) throw new UnauthorizedException('Senha incorreta');

    const store = await this.storesRepository.findOne({
      where: { id: storeId, owner: { id: vendorId } },
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');

    const token = crypto.randomBytes(32).toString('hex');
    store.deleteToken = token;
    store.deleteTokenExpires = new Date(Date.now() + 30 * 60 * 1000);
    await this.storesRepository.save(store);

    // KAN-258 (mesma classe do fallback de API_URL nos frontends): este link vai
    // POR E-MAIL para o lojista. Se APP_URL nao estiver definida em producao, o
    // fallback antigo mandava um link para `localhost:3000` — inutil para quem
    // recebe. Agora avisa alto e usa o dominio publico.
    const apiUrl = resolvePublicUrl(this.configService, 'APP_URL', 'http://localhost:3000');
    const confirmUrl = `${apiUrl}/stores/confirm-delete?token=${token}`;

    await this.mailService.sendStoreDeleteConfirmation(
      vendor.email,
      vendor.name,
      store.name,
      confirmUrl,
    );
    if (vendor.phone) {
      this.whatsAppService
        .notifyStoreDeleteRequest(
          vendor.phone,
          vendor.name,
          store.name,
          confirmUrl,
        )
        .catch(() => {});
    }
    return true;
  }

  async confirmStoreDelete(token: string): Promise<string> {
    const store = await this.storesRepository.findOne({
      where: { deleteToken: token },
    });
    if (!store) throw new BadRequestException('Token invalido');
    if (!store.deleteTokenExpires || store.deleteTokenExpires < new Date()) {
      throw new BadRequestException(
        'Token expirado. Solicite a exclusao novamente.',
      );
    }

    const storeName = store.name;
    await this.storesRepository.remove(store);
    return storeName;
  }

  async totalCount(): Promise<number> {
    return this.storesRepository.count();
  }

  async saveStore(store: Store): Promise<Store> {
    return this.storesRepository.save(store);
  }

  // Follow system
  async followStore(userId: string, storeId: string): Promise<boolean> {
    const store = await this.storesRepository.findOne({
      where: { id: storeId },
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');

    const existing = await this.storeFollowRepository.findOne({
      where: { user: { id: userId }, store: { id: storeId } },
    });
    if (existing) return true; // already following

    const follow = this.storeFollowRepository.create({
      user: { id: userId } as AppUser,
      store: { id: storeId } as Store,
    });
    await this.storeFollowRepository.save(follow);
    return true;
  }

  async unfollowStore(userId: string, storeId: string): Promise<boolean> {
    await this.storeFollowRepository.delete({
      user: { id: userId },
      store: { id: storeId },
    });
    return true;
  }

  async isFollowing(userId: string, storeId: string): Promise<boolean> {
    const count = await this.storeFollowRepository.count({
      where: { user: { id: userId }, store: { id: storeId } },
    });
    return count > 0;
  }

  async getFollowedStores(userId: string): Promise<Store[]> {
    const follows = await this.storeFollowRepository.find({
      where: { user: { id: userId } },
      relations: ['store', 'store.owner'],
      order: { createdAt: 'DESC' },
    });
    const stores = follows.map((f) => f.store).filter((s) => s.isActive);
    return this.sortByPriority(stores);
  }

  async getFollowerCount(storeId: string): Promise<number> {
    return this.storeFollowRepository.count({
      where: { store: { id: storeId } },
    });
  }

}
