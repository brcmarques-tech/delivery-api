import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Headers,
  HttpCode,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { StoresService } from '../stores/stores.service';
import { businessTodayDate } from '../common/utils/business-time';
import { OrdersService } from '../orders/orders.service';
import { ProductsService } from '../products/products.service';
import { CouponsService } from '../coupons/coupons.service';
import { AppUser } from '../users/entities/app-user.entity';
import { Store } from '../stores/entities/store.entity';
import { OrderStatus } from '../common/enums';

@Controller('n8n')
export class N8nAgentController {
  constructor(
    private readonly storesService: StoresService,
    private readonly ordersService: OrdersService,
    private readonly productsService: ProductsService,
    private readonly couponsService: CouponsService,
    private readonly configService: ConfigService,
    @InjectRepository(AppUser)
    private readonly appUsersRepository: Repository<AppUser>,
    @InjectRepository(Store)
    private readonly storesRepository: Repository<Store>,
  ) {}

  private checkAuth(key: string) {
    const expected = this.configService.get<string>('N8N_AGENT_KEY');
    if (!expected) throw new UnauthorizedException();
    // #6: comparação em tempo constante (igual ao webhook do Pagar.me), evitando
    // o vazamento de timing do `!==` que permitiria descobrir a chave byte a byte.
    const a = Buffer.from(String(key || ''));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException();
    }
  }

  @Get('stores/by-phone')
  async storeByPhone(
    @Query('phone') phone: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const digits = phone?.replace(/\D/g, '') ?? '';
    const store = await this.storesService.findByWhatsappNumber(digits);
    if (!store) return null;
    return {
      id: store.id,
      name: store.name,
      city: store.city,
      state: store.state,
    };
  }

  @Get('users/by-phone')
  async userByPhone(
    @Query('phone') phone: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const digits = phone?.replace(/\D/g, '') ?? '';
    // BUGFIX: a busca casava so os ULTIMOS 8 DIGITOS do telefone. Numeros
    // brasileiros que diferem apenas no DDD colidem (+55 11 99999-1234 vs
    // +55 53 99999-1234) e `getOne()` devolvia uma linha ARBITRARIA — o agente
    // do WhatsApp entao respondia a um cliente com o historico de pedidos de
    // OUTRA pessoa. Pior ainda: telefone ausente/nao-numerico virava
    // `LIKE '%'`, que casa TODO MUNDO, prendendo a conversa a uma conta
    // aleatoria. Como `phone` nao e unico, tambem recusamos ambiguidade.
    if (digits.length < 10) return null;
    const matches = await this.appUsersRepository
      .createQueryBuilder('u')
      .where("regexp_replace(u.phone, '[^0-9]', '', 'g') = :digits", { digits })
      .orWhere("regexp_replace(u.phone, '[^0-9]', '', 'g') = :noCountry", {
        noCountry: digits.startsWith('55') ? digits.slice(2) : digits,
      })
      .getMany();
    if (matches.length !== 1) return null;
    const user = matches[0];
    return { id: user.id, name: user.name, phone: user.phone };
  }

  @Get('orders/pending')
  async pendingOrders(
    @Query('storeId') storeId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const orders = await this.ordersService.findByStore(storeId);
    const pending = orders.filter((o) =>
      [
        OrderStatus.PENDING,
        OrderStatus.AWAITING_PAYMENT,
        OrderStatus.PAYMENT_REVIEW,
      ].includes(o.status),
    );
    return {
      count: pending.length,
      orders: pending.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        customer: o.customer?.name,
        total: o.total,
        items: o.items
          ?.map((i) => `${i.quantity}x ${i.product?.name}`)
          .join(', '),
      })),
    };
  }

  @Get('orders/summary')
  async dailySummary(
    @Query('storeId') storeId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const orders = await this.ordersService.findByStore(storeId);
    // BUGFIX: `setHours(0,0,0,0)` usava o fuso do PROCESSO (UTC em producao), o
    // que corta o dia as 21:00 BRT do dia anterior. O vendedor pedia "resumo de
    // hoje" as 20:00 e recebia pedidos de ontem a noite junto — e os de hoje a
    // noite eram contados de novo amanha. Receita reportada no dia errado todo
    // santo dia. Agora a virada do dia e no fuso do negocio.
    const today = businessTodayDate();
    const todayOrders = orders.filter((o) => new Date(o.createdAt) >= today);
    // O caminho feliz termina em COMPLETED (DELIVERING -> DELIVERER_CONFIRMED_DELIVERY
    // -> COMPLETED); DELIVERED é um estado alternativo. Filtrar só DELIVERED fazia
    // o agente reportar ~R$0 de receita mesmo em dias cheios de pedidos concluídos.
    const delivered = todayOrders.filter((o) =>
      [OrderStatus.DELIVERED, OrderStatus.COMPLETED].includes(o.status),
    );
    const inProgress = todayOrders.filter((o) =>
      [
        OrderStatus.PENDING,
        OrderStatus.ACCEPTED,
        OrderStatus.PREPARING,
        OrderStatus.READY,
        OrderStatus.DELIVERING,
        OrderStatus.PICKED_UP,
        OrderStatus.VENDOR_CONFIRMED_PICKUP,
        OrderStatus.DELIVERER_CONFIRMED_DELIVERY,
      ].includes(o.status),
    );
    const revenue = delivered.reduce((sum, o) => sum + Number(o.total), 0);
    return {
      todayOrders: todayOrders.length,
      delivered: delivered.length,
      inProgress: inProgress.length,
      revenue: `R$${revenue.toFixed(2)}`,
    };
  }

  @Get('orders/customer')
  async ordersByCustomer(
    @Query('customerId') customerId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const orders = await this.ordersService.findByCustomer(customerId);
    return {
      count: orders.length,
      orders: orders.slice(0, 5).map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        store: o.store?.name,
        total: o.total,
        createdAt: o.createdAt,
      })),
    };
  }

  @Get('orders/number/:orderNumber')
  async orderByNumber(
    @Param('orderNumber') orderNumber: string,
    @Query('customerId') customerId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const order = await this.ordersService.findByOrderNumber(orderNumber);
    if (!order) throw new NotFoundException('Pedido nao encontrado');
    // BUGFIX: a checagem era OPCIONAL (`customerId && ...`) — bastava o
    // workflow omitir o parametro para o agente narrar o pedido de qualquer
    // pessoa a quem perguntasse pelo numero (numeros de pedido circulam em
    // mensagens e comprovantes). O endpoint de status ja exigia posse; estes
    // ficaram para tras. Agora a identificacao e obrigatoria.
    if (!customerId) {
      throw new ForbiddenException('Identificacao do cliente obrigatoria');
    }
    if (order.customer?.id !== customerId) {
      throw new ForbiddenException('Pedido nao pertence a este cliente');
    }
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      store: order.store?.name,
      storeId: order.store?.id,
      customerId: order.customer?.id,
      total: order.total,
      items: order.items
        ?.map((i) => `${i.quantity}x ${i.product?.name}`)
        .join(', '),
      createdAt: order.createdAt,
    };
  }

  @Get('orders')
  async ordersByStore(
    @Query('storeId') storeId: string,
    @Query('status') status: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const orders = await this.ordersService.findByStore(storeId);
    const filtered = status
      ? orders.filter((o) => o.status === status)
      : orders.slice(0, 10);
    return {
      count: filtered.length,
      orders: filtered.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        customer: o.customer?.name,
        total: o.total,
      })),
    };
  }

  // --- Store management ---

  @Get('stores/:id')
  async storeDetails(
    @Param('id') id: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const store = await this.storesService.findById(id);
    if (!store) throw new NotFoundException('Loja nao encontrada');
    return {
      id: store.id,
      name: store.name,
      isOpen: store.isOpen,
      deliveryStartTime: store.deliveryStartTime,
      deliveryEndTime: store.deliveryEndTime,
      deliveryFee: store.deliveryFee,
      minimumOrder: store.minimumOrder,
      estimatedDeliveryMinutes: store.estimatedDeliveryMinutes,
    };
  }

  @Post('stores/:id/toggle-open')
  @HttpCode(200)
  async toggleStoreOpen(
    @Param('id') id: string,
    @Headers('x-n8n-key') key: string,
    @Query('storeId') storeId?: string,
  ) {
    this.checkAuth(key);
    // BUGFIX: nao havia NENHUM vinculo entre a loja alvo e a conversa. A chave
    // do n8n e unica e compartilhada por todos os workflows, entao uma mensagem
    // contendo o id de outra loja ("feche a loja <uuid>") fazia o agente fechar
    // a loja de um CONCORRENTE. Agora a loja da conversa (resolvida pelo
    // telefone via stores/by-phone) precisa bater com o alvo.
    if (!storeId || storeId !== id) {
      throw new ForbiddenException('Loja da conversa nao confere com a loja alvo');
    }
    const store = await this.storesRepository.findOne({ where: { id } });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    store.isOpen = !store.isOpen;
    const saved = await this.storesRepository.save(store);
    return { storeName: saved.name, isOpen: saved.isOpen };
  }

  // --- Product management ---

  @Get('products')
  async productsByStore(
    @Query('storeId') storeId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const products = await this.productsService.findByStore(storeId);
    return products.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      promotionalPrice: p.promotionalPrice ?? null,
      stock: p.stock,
      isAvailable: p.isAvailable,
      category: p.category?.name ?? null,
    }));
  }

  @Patch('products/:id/availability')
  async toggleProductAvailability(
    @Param('id') id: string,
    @Headers('x-n8n-key') key: string,
    @Query('storeId') storeId?: string,
  ) {
    this.checkAuth(key);
    // BUGFIX: mesmo buraco do toggle-open — um id de produto copiado de uma
    // listagem publica permitia esconder o produto de outro vendedor.
    if (!storeId) {
      throw new ForbiddenException('Loja da conversa obrigatoria');
    }
    const alvo = await this.productsService.findById(id);
    if ((alvo as any)?.store?.id !== storeId) {
      throw new ForbiddenException('Produto nao pertence a esta loja');
    }
    const product = await this.productsService.toggleAvailability(id);
    return { productName: product.name, isAvailable: product.isAvailable };
  }

  // --- Coupon management ---

  @Get('coupons')
  async couponsByStore(
    @Query('storeId') storeId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const coupons = await this.couponsService.findByStore(storeId);
    return coupons.map((c) => ({
      code: c.code,
      discountType: c.discountType,
      discountValue: c.discountValue,
      usesCount: c.usesCount,
      maxUses: c.maxUses,
      isActive: c.isActive,
      expiresAt: c.expiresAt,
    }));
  }

  // --- Order tracking ---

  @Get('orders/:orderNumber/tracking')
  async orderTracking(
    @Param('orderNumber') orderNumber: string,
    @Query('customerId') customerId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const order = await this.ordersService.findByOrderNumber(orderNumber);
    if (!order) throw new NotFoundException('Pedido nao encontrado');
    // BUGFIX: posse era opcional. Este endpoint devolve NOME, TELEFONE e a
    // POSICAO GPS AO VIVO do entregador — sem a checagem obrigatoria, qualquer
    // um com um numero de pedido rastreava o entregador de outra pessoa.
    if (!customerId) {
      throw new ForbiddenException('Identificacao do cliente obrigatoria');
    }
    if (order.customer?.id !== customerId) {
      throw new ForbiddenException('Pedido nao pertence a este cliente');
    }
    const delivery = order.delivery;
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      estimatedDeliveryEta: order.estimatedDeliveryEta ?? null,
      delivererName: delivery?.deliverer?.name ?? null,
      delivererPhone: delivery?.deliverer?.phone ?? null,
      currentLatitude: delivery?.currentLatitude ?? null,
      currentLongitude: delivery?.currentLongitude ?? null,
    };
  }

  @Post('orders/status')
  @HttpCode(200)
  async updateOrderStatus(
    @Body()
    body: {
      orderNumber: string;
      status: string;
      actorEmail?: string;
      storeId?: string;
      customerId?: string;
    },
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);

    // #4: exige um identificador de POSSE. ANTES, um corpo só com
    // {orderNumber,status} pulava as duas checagens abaixo e transicionava
    // QUALQUER pedido para QUALQUER status — inclusive COMPLETED, que dispara o
    // repasse (settlePayment). Agora é obrigatório storeId OU customerId.
    if (!body.storeId && !body.customerId) {
      throw new ForbiddenException('Informe storeId ou customerId para atualizar o pedido.');
    }

    // #4: o agente não pode dirigir estados de entrega/liquidação (que movem
    // dinheiro): PICKED_UP/DELIVERING/DELIVERED/DELIVERER_CONFIRMED_DELIVERY/
    // COMPLETED/VENDOR_CONFIRMED_PICKUP ficam de fora.
    const AGENT_ALLOWED_STATUSES = ['ACCEPTED', 'PREPARING', 'READY', 'CANCELLED', 'REJECTED'];
    if (!AGENT_ALLOWED_STATUSES.includes(body.status)) {
      throw new ForbiddenException('O agente nao pode definir este status do pedido.');
    }

    const order = await this.ordersService.findByOrderNumber(body.orderNumber);
    if (!order) throw new NotFoundException('Pedido nao encontrado');

    // If storeId provided, verify vendor ownership
    if (body.storeId && order.store?.id !== body.storeId) {
      throw new ForbiddenException('Pedido nao pertence a esta loja');
    }

    // If customerId provided (customer agent), verify customer ownership
    if (
      (body as any).customerId &&
      order.customer?.id !== (body as any).customerId
    ) {
      throw new ForbiddenException('Pedido nao pertence a este cliente');
    }

    const actorEmail =
      body.actorEmail ??
      this.configService.get('AGENT_APP_USER_EMAIL', 'agente@bcmtech.com.br');
    const actor = await this.appUsersRepository.findOne({
      where: { email: actorEmail },
    });
    if (!actor) throw new NotFoundException('Usuario agente nao encontrado');

    const updated = await this.ordersService.updateStatus(
      order.id,
      body.status as OrderStatus,
      actor,
    );
    return {
      success: true,
      orderNumber: updated.orderNumber,
      newStatus: updated.status,
    };
  }
}
