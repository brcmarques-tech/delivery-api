import { Injectable, NotFoundException, BadRequestException, UnauthorizedException, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Store } from './entities/store.entity';
import { CreateStoreInput } from './dto/create-store.input';
import { UpdateStoreInput } from './dto/update-store.input';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { PlatformConfigService } from '../config/platform-config.service';
import { MailService } from '../mail/mail.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { PUB_SUB } from '../pubsub/pubsub.module';

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);

  constructor(
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    @InjectRepository(AppUser)
    private appUsersRepository: Repository<AppUser>,
    @InjectRepository(VendorUser)
    private vendorUsersRepository: Repository<VendorUser>,
    private platformConfigService: PlatformConfigService,
    private mailService: MailService,
    private whatsAppService: WhatsAppService,
    private configService: ConfigService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  private async geocodeAddress(input: CreateStoreInput): Promise<{ latitude: number; longitude: number }> {
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
        const res = await fetch(url, {
          headers: { 'User-Agent': 'bcmTech-Delivery/1.0' },
        });
        const data = await res.json();
        if (data.length > 0) {
          this.logger.log(`Geocoded with query: "${query}"`);
          return { latitude: parseFloat(data[0].lat), longitude: parseFloat(data[0].lon) };
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
    const planConfig = await this.platformConfigService.getPlanConfig(owner.vendorPlan || 'FREE');
    const currentStores = await this.storesRepository.count({
      where: { owner: { id: owner.id } },
    });

    if (currentStores >= planConfig.maxStores) {
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
    this.pubSub.publish('storeUpdated', { storeUpdated: saved });
    return saved;
  }

  private isWithinHighlightDays(highlightDaysPerMonth: number): boolean {
    if (highlightDaysPerMonth >= 30) return true;
    if (highlightDaysPerMonth <= 0) return false;
    const today = new Date().getDate();
    return today <= highlightDaysPerMonth;
  }

  private async sortByPriority(stores: Store[]): Promise<Store[]> {
    const storesWithPriority = await Promise.all(
      stores.map(async (store) => {
        const plan = store.owner?.vendorPlan || 'FREE';
        const config = await this.platformConfigService.getPlanConfig(plan);
        const isHighlighted = this.isWithinHighlightDays(config.highlightDaysPerMonth);
        const effectivePriority = isHighlighted ? config.listingPriority : 0;
        return { store, effectivePriority };
      }),
    );
    storesWithPriority.sort((a, b) => b.effectivePriority - a.effectivePriority);
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
      relations: ['owner', 'products', 'products.category', 'categories'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    return store;
  }

  async findByOwner(ownerId: string): Promise<Store[]> {
    return this.storesRepository.find({
      where: { owner: { id: ownerId } },
      relations: ['owner', 'products', 'products.category', 'categories'],
    });
  }

  async findNearby(lat: number, lng: number, radiusKm: number = 10): Promise<Store[]> {
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
    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) (store as any)[key] = value;
    });
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

  async requestStoreDelete(storeId: string, adminId: string, password: string): Promise<boolean> {
    const admin = await this.appUsersRepository.findOne({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('Admin nao encontrado');

    const passwordValid = await bcrypt.compare(password, admin.password);
    if (!passwordValid) throw new UnauthorizedException('Senha incorreta');

    const store = await this.storesRepository.findOne({ where: { id: storeId }, relations: ['owner'] });
    if (!store) throw new NotFoundException('Loja nao encontrada');

    const token = crypto.randomBytes(32).toString('hex');
    store.deleteToken = token;
    store.deleteTokenExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await this.storesRepository.save(store);

    const apiUrl = this.configService.get('APP_URL', 'http://localhost:3000');
    const confirmUrl = `${apiUrl}/stores/confirm-delete?token=${token}`;

    const emailTo = admin.notificationEmail || admin.email;
    await this.mailService.sendStoreDeleteConfirmation(emailTo, admin.name, store.name, confirmUrl);
    if (admin.phone) {
      this.whatsAppService.notifyStoreDeleteRequest(admin.phone, admin.name, store.name, confirmUrl).catch(() => {});
    }
    return true;
  }

  async requestVendorStoreDelete(storeId: string, vendorId: string, password: string): Promise<boolean> {
    const vendor = await this.vendorUsersRepository.findOne({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Vendedor nao encontrado');

    const passwordValid = await bcrypt.compare(password, vendor.password);
    if (!passwordValid) throw new UnauthorizedException('Senha incorreta');

    const store = await this.storesRepository.findOne({ where: { id: storeId, owner: { id: vendorId } } });
    if (!store) throw new NotFoundException('Loja nao encontrada');

    const token = crypto.randomBytes(32).toString('hex');
    store.deleteToken = token;
    store.deleteTokenExpires = new Date(Date.now() + 30 * 60 * 1000);
    await this.storesRepository.save(store);

    const apiUrl = this.configService.get('APP_URL', 'http://localhost:3000');
    const confirmUrl = `${apiUrl}/stores/confirm-delete?token=${token}`;

    await this.mailService.sendStoreDeleteConfirmation(vendor.email, vendor.name, store.name, confirmUrl);
    if (vendor.phone) {
      this.whatsAppService.notifyStoreDeleteRequest(vendor.phone, vendor.name, store.name, confirmUrl).catch(() => {});
    }
    return true;
  }

  async confirmStoreDelete(token: string): Promise<string> {
    const store = await this.storesRepository.findOne({ where: { deleteToken: token } });
    if (!store) throw new BadRequestException('Token invalido');
    if (!store.deleteTokenExpires || store.deleteTokenExpires < new Date()) {
      throw new BadRequestException('Token expirado. Solicite a exclusao novamente.');
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
}
