import {
  Resolver,
  Query,
  Mutation,
  Args,
  Float,
  Int,
  ResolveField,
  Parent,
  Subscription,
  Context,
} from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { verify as jwtVerify } from 'jsonwebtoken'; // KAN-259
import { PubSub } from 'graphql-subscriptions';
import { Store } from './entities/store.entity';
import { Product } from '../products/entities/product.entity';
import { StoresService } from './stores.service';
import { StorefrontResult, PublicStoreCard } from './dto/storefront-result';
import { AppUser } from '../users/entities/app-user.entity';
import { VerificationService } from './verification.service';
import { CreateStoreInput } from './dto/create-store.input';
import { UpdateStoreInput } from './dto/update-store.input';
import { MailService } from '../mail/mail.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permission } from '../auth/decorators/permission.decorator';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { UserRole, VerificationLevel } from '../common/enums';
import { PlatformConfigService } from '../config/platform-config.service';
import { DelivererTrackerService } from '../deliveries/deliverer-tracker.service';
import {
  VEHICLE_AVG_SPEEDS_KMH,
  DEFAULT_AVG_SPEED_KMH,
  PREPARATION_TIME_MINUTES,
  ROAD_FACTOR,
} from '../common/delivery-constants';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { DistanciaService } from '../common/geo/distancia.service';

@Resolver(() => Store)
export class StoresResolver {
  constructor(
    private storesService: StoresService,
    private verificationService: VerificationService,
    private platformConfigService: PlatformConfigService,
    private mailService: MailService,
    private delivererTracker: DelivererTrackerService,
    private distanciaService: DistanciaService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  createStore(
    @Args('input') input: CreateStoreInput,
    @CurrentUser() user: VendorUser,
  ): Promise<Store> {
    return this.storesService.create(input, user);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  updateStore(
    @Args('input') input: UpdateStoreInput,
    @CurrentUser() user: VendorUser,
  ): Promise<Store> {
    return this.storesService.update(input, user);
  }

  // Perf (F6): argumentos todos opcionais — sem nenhum, o retorno e o mesmo de
  // antes. Os filtros existem para a aba de busca do app parar de baixar a
  // tabela de lojas inteira e filtrar no cliente.
  @Query(() => [Store])
  stores(
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
    @Args('search', { type: () => String, nullable: true }) search?: string,
    @Args('storeType', { type: () => String, nullable: true }) storeType?: string,
    @Args('onlyOpen', { type: () => Boolean, nullable: true }) onlyOpen?: boolean,
    @Args('onlyFreeDelivery', { type: () => Boolean, nullable: true })
    onlyFreeDelivery?: boolean,
  ): Promise<Store[]> {
    return this.storesService.findAll({
      limit,
      offset,
      search,
      storeType,
      onlyOpen,
      onlyFreeDelivery,
    });
  }

  @Query(() => Store)
  store(@Args('id') id: string): Promise<Store> {
    return this.storesService.findById(id);
  }

  @Query(() => Store)
  storeBySlug(@Args('slug') slug: string): Promise<Store> {
    return this.storesService.findBySlug(slug);
  }

  // Perf (F5/F6): catalogo paginado + busca server-side (tela da loja do app).
  @Query(() => [Product])
  storeProducts(
    @Args('storeId') storeId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 100 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
    @Args('search', { nullable: true }) search?: string,
    @Args('categoryId', { nullable: true }) categoryId?: string,
  ): Promise<Product[]> {
    return this.storesService.findStoreProducts(storeId, limit, offset, search, categoryId);
  }

  @Query(() => StorefrontResult)
  publicStorefront(
    @Args('storeId', { nullable: true }) storeId?: string,
    @Args('slug', { nullable: true }) slug?: string,
  ): Promise<StorefrontResult> {
    return this.storesService.getPublicStorefront(storeId, slug);
  }

  @Query(() => [PublicStoreCard])
  publicStores(): Promise<PublicStoreCard[]> {
    return this.storesService.getPublicStores();
  }

  @Query(() => [Store])
  nearbyStores(
    @Args('latitude', { type: () => Float }) lat: number,
    @Args('longitude', { type: () => Float }) lng: number,
    @Args('radiusKm', { type: () => Float, nullable: true }) radius?: number,
  ): Promise<Store[]> {
    return this.storesService.findNearby(lat, lng, radius);
  }

  @Query(() => [Store])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  myStores(@CurrentUser() user: VendorUser): Promise<Store[]> {
    return this.storesService.findByOwner(user.id);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  toggleStoreOpen(
    @Args('id') id: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Store> {
    return this.storesService.toggleOpen(id, user);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  requestVendorStoreDelete(
    @Args('storeId') storeId: string,
    @Args('password') password: string,
    @CurrentUser() user: VendorUser,
  ): Promise<boolean> {
    return this.storesService.requestVendorStoreDelete(
      storeId,
      user.id,
      password,
    );
  }

  @Query(() => [Store])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allStores(): Promise<Store[]> {
    return this.storesService.findAllAdmin();
  }

  @Query(() => Float)
  async calculateDeliveryFee(
    @Args('storeId') storeId: string,
    @Args('customerLatitude', { type: () => Float }) customerLat: number,
    @Args('customerLongitude', { type: () => Float }) customerLng: number,
  ): Promise<number> {
    // Perf (F5): findByIdBasic — so precisa de lat/lng, nao do catalogo inteiro.
    const store = await this.storesService.findByIdBasic(storeId);
    const pricePerKm = await this.platformConfigService.getDeliveryPricePerKm();
    const basePrice = await this.platformConfigService.getDeliveryBasePrice();

    // KAN-29: MESMA conta do createOrder (DistanciaService) — este numero e o
    // que o cliente ve antes de confirmar. Se divergisse do cobrado, o cliente
    // veria um preco e pagaria outro.
    const distancia = await this.distanciaService.entre(
      Number(store.latitude),
      Number(store.longitude),
      customerLat,
      customerLng,
    );

    const fee = basePrice + distancia.km * pricePerKm;
    return Math.round(fee * 100) / 100;
  }

  @Query(() => Float)
  async estimatedDeliveryTime(
    @Args('storeId') storeId: string,
    @Args('customerLatitude', { type: () => Float }) customerLat: number,
    @Args('customerLongitude', { type: () => Float }) customerLng: number,
  ): Promise<number> {
    // Perf (F5): findByIdBasic — so precisa de lat/lng/hasOwnDelivery.
    const store = await this.storesService.findByIdBasic(storeId);

    if (store.hasOwnDelivery) {
      return store.estimatedDeliveryMinutes || 30;
    }

    const storeLat = Number(store.latitude);
    const storeLng = Number(store.longitude);

    // KAN-29: a perna LOJA->CLIENTE vem da rota de verdade. O ROAD_FACTOR
    // (que existia justamente porque a linha reta subestima) deixa de ser
    // aplicado nela quando a distancia veio roteada — seria corrigir duas
    // vezes a mesma coisa e empurrar a estimativa para cima.
    const trecho = await this.distanciaService.entre(
      storeLat,
      storeLng,
      customerLat,
      customerLng,
    );

    const nearest = this.delivererTracker.getNearestDelivererInfo(
      storeLat,
      storeLng,
    );
    const delivererToStoreKm = nearest ? nearest.distanceKm : 3;
    const vehicleType = nearest ? nearest.vehicleType : 'MOTO';
    const speed = VEHICLE_AVG_SPEEDS_KMH[vehicleType] || DEFAULT_AVG_SPEED_KMH;

    // A perna ENTREGADOR->LOJA continua em linha reta (vem do rastreador, e
    // nao vale uma chamada de roteamento a cada abertura de tela), entao ela
    // mantem o fator de via.
    const minutosAteALoja = ((delivererToStoreKm * ROAD_FACTOR) / speed) * 60;
    const minutosAteOCliente =
      trecho.fonte === 'rota'
        ? trecho.minutos
        : ((trecho.km * ROAD_FACTOR) / speed) * 60;
    const totalMinutes =
      minutosAteALoja + minutosAteOCliente + PREPARATION_TIME_MINUTES;

    return Math.ceil(totalMinutes);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('stores')
  async toggleStoreActive(
    @Args('id') id: string,
    @CurrentUser() admin: any,
  ): Promise<Store> {
    const result = await this.storesService.toggleActive(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService
      .sendAdminActionEmail(
        adminEmail,
        admin.name,
        `Loja ${result.isActive ? 'ativada' : 'desativada'}`,
        `Loja: ${result.name} (ID: ${result.id})`,
      )
      .catch(() => {});
    return result;
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('stores')
  requestStoreDelete(
    @Args('storeId') storeId: string,
    @Args('password') password: string,
    @CurrentUser() user: any,
  ): Promise<boolean> {
    return this.storesService.requestStoreDelete(storeId, user.id, password);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  recalculateVerification(
    @Args('storeId') storeId: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Store> {
    // KAN-253: passa o dono para validar ownership — era IDOR, qualquer vendor
    // recalculava a verificacao de loja alheia. Mesmo padrao do claimBadgeReward.
    return this.verificationService.recalculateScore(storeId, user.id);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  claimBadgeReward(
    @Args('storeId') storeId: string,
    @Args('level') level: string,
    @CurrentUser() user: VendorUser,
  ): Promise<Store> {
    return this.verificationService.claimBadgeReward(storeId, level, user.id);
  }

  @Mutation(() => Store)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('stores')
  async setStoreVerification(
    @Args('storeId') storeId: string,
    @Args('level', { type: () => VerificationLevel }) level: VerificationLevel,
    @CurrentUser() admin: any,
    @Args('score', { type: () => Float, nullable: true }) score?: number,
  ): Promise<Store> {
    const store = await this.storesService.findById(storeId);
    store.verificationLevel = level;
    if (score !== undefined && score !== null) {
      store.verificationScore = score;
    }
    const result = await this.storesService.saveStore(store);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService
      .sendAdminActionEmail(
        adminEmail,
        admin.name,
        'Verificacao de loja alterada',
        `Loja: ${store.name}\nNivel: ${level}${score !== undefined ? `\nScore: ${score}` : ''}`,
      )
      .catch(() => {});
    return result;
  }

  // Follow system
  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  followStore(
    @Args('storeId') storeId: string,
    @CurrentUser() user: AppUser,
  ): Promise<boolean> {
    return this.storesService.followStore(user.id, storeId);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  unfollowStore(
    @Args('storeId') storeId: string,
    @CurrentUser() user: AppUser,
  ): Promise<boolean> {
    return this.storesService.unfollowStore(user.id, storeId);
  }

  @Query(() => Boolean)
  @UseGuards(GqlAuthGuard)
  isFollowingStore(
    @Args('storeId') storeId: string,
    @CurrentUser() user: AppUser,
  ): Promise<boolean> {
    return this.storesService.isFollowing(user.id, storeId);
  }

  @Query(() => [Store])
  @UseGuards(GqlAuthGuard)
  followedStores(@CurrentUser() user: AppUser): Promise<Store[]> {
    return this.storesService.getFollowedStores(user.id);
  }

  @Query(() => Int)
  followerCount(@Args('storeId') storeId: string): Promise<number> {
    return this.storesService.getFollowerCount(storeId);
  }

  // KAN-259: so devolve o dono para requisicoes autenticadas. Anonimo recebe
  // null em vez de email/telefone/CPF do lojista. O superadmin (unico consumidor
  // real de `owner`) segue funcionando porque manda o Bearer token.
  @ResolveField(() => VendorUser, { nullable: true })
  owner(@Parent() store: Store, @Context() ctx: any): VendorUser | null {
    const raw: string =
      ctx?.req?.headers?.authorization || ctx?.req?.headers?.Authorization || '';
    const token = raw.replace(/^Bearer\s+/i, '').trim();
    const secret = process.env.JWT_SECRET;
    if (!token || !secret) return null;
    let payload: any;
    try {
      payload = jwtVerify(token, secret);
    } catch {
      return null;
    }
    // `owner` expõe PII do lojista (email, CPF, telefone, googleId). Antes bastava
    // um token VÁLIDO — qualquer cliente comum logado colhia os dados pessoais de
    // todos os donos de loja (as queries públicas stores/store/storeBySlug já
    // carregam a relação owner). Agora só o superadmin ou o próprio dono recebem;
    // os demais recebem null. (ownerPaymentConnected cobre o dado não-sensível.)
    const isSuperadmin = payload?.role === 'SUPERADMIN';
    const isOwner =
      payload?.sub && store.owner?.id && payload.sub === store.owner.id;
    if (!isSuperadmin && !isOwner) return null;
    return store.owner ?? null;
  }

  @ResolveField(() => Boolean)
  ownerPaymentConnected(@Parent() store: Store): boolean {
    return store.owner?.paymentConnected ?? false;
  }

  // I4: exige autenticação para assinar (dado público, mas antes era firehose
  // anônimo de todas as lojas). Clientes reais já assinam só logados.
  @UseGuards(GqlAuthGuard)
  @Subscription(() => Store, {
    filter: (payload, variables) =>
      !variables.storeId || payload.storeUpdated.id === variables.storeId,
  })
  storeUpdated(@Args('storeId', { nullable: true }) storeId?: string) {
    return this.pubSub.asyncIterableIterator('storeUpdated');
  }
}
