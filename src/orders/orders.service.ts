import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, In } from 'typeorm';
import * as crypto from 'crypto';
import { PubSub } from 'graphql-subscriptions';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderStatusLog } from './entities/order-status-log.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { CreateOrderInput, OrderItemInput } from './dto/create-order.input';
import { AppUser } from '../users/entities/app-user.entity';
import { ProductsService } from '../products/products.service';
import { StoresService } from '../stores/stores.service';
import { PaymentsService } from '../payments/payments.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { AddressesService } from '../addresses/addresses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CouponsService } from '../coupons/coupons.service';
import { VerificationService } from '../stores/verification.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { MailService } from '../mail/mail.service';
import { OrderStatus } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

type OnOrderReadyCallback = (order: Order) => void;

const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.AWAITING_PAYMENT]: [
    OrderStatus.PENDING,
    OrderStatus.PAYMENT_REVIEW,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
  ],
  [OrderStatus.PAYMENT_REVIEW]: [
    OrderStatus.PENDING,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
  ],
  [OrderStatus.PENDING]: [
    OrderStatus.ACCEPTED,
    OrderStatus.CANCELLED,
    OrderStatus.REJECTED,
    OrderStatus.EXPIRED,
  ],
  [OrderStatus.ACCEPTED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
  [OrderStatus.READY]: [
    OrderStatus.PICKED_UP,
    OrderStatus.VENDOR_CONFIRMED_PICKUP,
    OrderStatus.DELIVERING,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PICKED_UP]: [
    OrderStatus.VENDOR_CONFIRMED_PICKUP,
    OrderStatus.DELIVERING,
  ],
  [OrderStatus.VENDOR_CONFIRMED_PICKUP]: [OrderStatus.DELIVERING],
  [OrderStatus.DELIVERING]: [OrderStatus.DELIVERER_CONFIRMED_DELIVERY],
  [OrderStatus.DELIVERER_CONFIRMED_DELIVERY]: [
    OrderStatus.COMPLETED,
    OrderStatus.DISPUTED,
  ],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [OrderStatus.DISPUTED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REJECTED]: [],
  [OrderStatus.EXPIRED]: [],
  [OrderStatus.DISPUTED]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
};

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
    @InjectRepository(Delivery)
    private deliveriesRepository: Repository<Delivery>,
    @InjectRepository(OrderStatusLog)
    private orderStatusLogRepository: Repository<OrderStatusLog>,
    private productsService: ProductsService,
    private storesService: StoresService,
    private paymentsService: PaymentsService,
    private platformConfigService: PlatformConfigService,
    private addressesService: AddressesService,
    private notificationsService: NotificationsService,
    private couponsService: CouponsService,
    @Inject(forwardRef(() => VerificationService))
    private verificationService: VerificationService,
    private whatsAppService: WhatsAppService,
    private mailService: MailService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  private onOrderReadyCallback: OnOrderReadyCallback | null = null;

  onOrderReady(callback: OnOrderReadyCallback) {
    this.onOrderReadyCallback = callback;
  }

  async create(input: CreateOrderInput, customer: AppUser): Promise<Order> {
    const store = await this.storesService.findById(input.storeId);
    const isPickup = input.isPickup || false;

    if (!store.isOpen) {
      throw new BadRequestException('Esta loja esta fechada no momento');
    }

    if (store.deliveryStartTime && store.deliveryEndTime) {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      // Trata janelas que cruzam a meia-noite (ex.: 18:00 as 02:00). Antes a
      // comparação simples rejeitava o dia inteiro nesse caso, e a loja nunca
      // recebia pedido.
      const start = store.deliveryStartTime;
      const end = store.deliveryEndTime;
      const withinWindow =
        start <= end
          ? currentTime >= start && currentTime <= end
          : currentTime >= start || currentTime <= end;
      if (!withinWindow) {
        throw new BadRequestException(
          `Esta loja so aceita pedidos das ${store.deliveryStartTime} as ${store.deliveryEndTime}`,
        );
      }
    }

    if (!isPickup && !input.deliveryAddress) {
      throw new BadRequestException('Informe o endereco de entrega');
    }

    let subtotal = 0;
    const items: OrderItem[] = [];

    for (const itemInput of input.items) {
      const product = await this.productsService.findById(itemInput.productId);
      // C3: o produto TEM que ser da loja do pedido e estar disponível. Antes o
      // pedido aceitava produto de outra loja (preço/comissão calculados contra a
      // loja errada, corrompendo settlement) ou produto oculto/inativo.
      if (product.store?.id !== input.storeId) {
        throw new BadRequestException(
          `O produto "${product.name}" nao pertence a esta loja.`,
        );
      }
      if (!product.isActive || !product.isAvailable) {
        throw new BadRequestException(
          `O produto "${product.name}" nao esta disponivel no momento.`,
        );
      }
      const unitPrice = Number(product.promotionalPrice || product.price);

      let totalPrice: number;
      let quantity: number;
      let weightGrams: number | undefined;

      if (product.isVariableWeight && itemInput.weightGrams) {
        totalPrice = (unitPrice * itemInput.weightGrams) / 1000;
        quantity = 1;
        weightGrams = itemInput.weightGrams;
      } else {
        totalPrice = unitPrice * itemInput.quantity;
        quantity = itemInput.quantity;
      }

      subtotal += totalPrice;

      const orderItem = this.orderItemsRepository.create({
        product,
        quantity,
        unitPrice,
        totalPrice,
        notes: itemInput.notes,
        weightGrams,
      });
      items.push(orderItem);
    }

    // Verificação de idade: se algum produto pertence a categoria +18, exigir confirmação
    const hasAgeRestrictedItem = await this.hasAgeRestrictedProducts(
      input.items,
    );
    if (hasAgeRestrictedItem && !input.ageVerified) {
      throw new BadRequestException(
        'Este pedido contem produtos com restricao de idade. Confirme que voce tem 18 anos ou mais.',
      );
    }

    // Pedido mínimo: plataforma exige mínimo para entregadores do app (taxas Pagar.me + comissão)
    const platformMinimum =
      await this.platformConfigService.getMinimumOrderPlatform();
    const storeMinimumOrder = store.minimumOrder
      ? Number(store.minimumOrder)
      : 0;
    const effectiveMinimum = !store.hasOwnDelivery
      ? Math.max(platformMinimum, storeMinimumOrder)
      : storeMinimumOrder;

    if (effectiveMinimum > 0 && subtotal < effectiveMinimum) {
      throw new BadRequestException(
        `Pedido minimo ${!store.hasOwnDelivery ? 'para entrega pelo app' : 'desta loja'} e R$ ${effectiveMinimum.toFixed(2)}. Seu carrinho: R$ ${subtotal.toFixed(2)}.`,
      );
    }

    let deliveryFee = 0;

    if (!isPickup) {
      const storeFreeDelivery = store.freeDelivery;
      const freeAbove = store.freeDeliveryAbove
        ? Number(store.freeDeliveryAbove)
        : null;

      if (storeFreeDelivery || (freeAbove && subtotal >= freeAbove)) {
        deliveryFee = 0;
      } else if (input.deliveryLatitude && input.deliveryLongitude) {
        const pricePerKm =
          await this.platformConfigService.getDeliveryPricePerKm();
        const basePrice =
          await this.platformConfigService.getDeliveryBasePrice();
        const R = 6371;
        const dLat =
          ((input.deliveryLatitude - Number(store.latitude)) * Math.PI) / 180;
        const dLng =
          ((input.deliveryLongitude - Number(store.longitude)) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((Number(store.latitude) * Math.PI) / 180) *
            Math.cos((input.deliveryLatitude * Math.PI) / 180) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distanceKm = R * c;
        deliveryFee =
          Math.round((basePrice + distanceKm * pricePerKm) * 100) / 100;
      } else {
        // C2: pedido de entrega SEM coordenadas (ex.: o checkout do storefront
        // não envia lat/long) não conseguia calcular a distância e caía em frete
        // 0 — entrega grátis por omissão, com o entregador do app trabalhando de
        // graça. Cai no frete FIXO configurado pela própria loja (store.deliveryFee)
        // como piso, em vez de zerar silenciosamente.
        deliveryFee = Number(store.deliveryFee) || 0;
      }
    }

    let discount = 0;
    let couponCode: string | undefined;
    let couponEntity: any = null;
    if (input.couponCode) {
      const result = await this.couponsService.validateAndCalculate(
        input.couponCode,
        input.storeId,
        subtotal,
        customer.id,
      );
      discount = result.discount;
      couponCode = result.coupon.code;
      couponEntity = result.coupon;
    }

    const total = subtotal - discount + deliveryFee;

    const storeOwner = store.owner;
    const vendorPlan = storeOwner?.vendorPlan || 'FREE';
    const planConfig =
      await this.platformConfigService.getPlanConfig(vendorPlan);
    let commissionPercent = planConfig.commissionPercent;

    if (
      store.commissionReductionPercent > 0 &&
      store.commissionReductionExpiresAt &&
      new Date(store.commissionReductionExpiresAt) > new Date()
    ) {
      commissionPercent = Math.max(
        0,
        commissionPercent - Number(store.commissionReductionPercent),
      );
    }

    const commissionAmount =
      Math.round((((subtotal - discount) * commissionPercent) / 100) * 100) /
      100;

    let paymentMethod = (input.paymentMethod || 'ON_DELIVERY').toUpperCase();

    // H6: MERCADO_PAGO is deprecated — translate to CREDIT_CARD (Pagar.me migration)
    if (paymentMethod === 'MERCADO_PAGO') {
      paymentMethod = 'CREDIT_CARD';
    }

    const vendorPaymentConnected = storeOwner?.paymentConnected ?? false;

    if (!vendorPaymentConnected && paymentMethod !== 'ON_DELIVERY') {
      throw new BadRequestException(
        'Esta loja ainda nao aceita pagamentos online. Escolha pagamento na entrega ou retirada.',
      );
    }

    if (!vendorPaymentConnected && !store.hasOwnDelivery && !isPickup) {
      throw new BadRequestException(
        'Esta loja so aceita retirada no local no momento.',
      );
    }

    if (paymentMethod === 'ON_DELIVERY' && !isPickup && !store.hasOwnDelivery) {
      throw new BadRequestException(
        'Pagamento na entrega nao disponivel para esta loja. Use PIX ou cartao.',
      );
    }

    const needsPayment = paymentMethod !== 'ON_DELIVERY';

    if (needsPayment && !customer.cpf) {
      throw new BadRequestException(
        'CPF obrigatorio para pagamento online. Atualize seu perfil.',
      );
    }

    // H5: Wrap order creation + stock decrement in a transaction to prevent race conditions
    const savedOrder = await this.ordersRepository.manager.transaction(
      async (manager) => {
        const order = manager.getRepository(Order).create({
          orderNumber: `ORD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
          customer,
          store,
          items,
          subtotal,
          deliveryFee,
          total,
          commissionPercent,
          commissionAmount,
          isPickup,
          deliveryAddress: isPickup
            ? `${store.street}, ${store.number} - ${store.neighborhood}, ${store.city}`
            : input.deliveryAddress,
          deliveryLatitude: isPickup
            ? Number(store.latitude)
            : input.deliveryLatitude,
          deliveryLongitude: isPickup
            ? Number(store.longitude)
            : input.deliveryLongitude,
          notes: input.notes,
          paymentMethod,
          couponCode,
          discount,
          coupon: couponEntity,
          // KAN-234: `couponCredited` passa a significar "o uso deste cupom ja
          // foi contabilizado para ESTE pedido". Em ON_DELIVERY o incremento
          // acontece logo abaixo, na criacao; em pagamento online so depois do
          // webhook de confirmacao (que ja seta a flag). Sem isso, o decremento
          // no cancelamento nao tinha como saber se houve incremento.
          couponCredited: !!couponEntity && !needsPayment,
          status: needsPayment
            ? OrderStatus.AWAITING_PAYMENT
            : OrderStatus.PENDING,
        });

        const saved = await manager.getRepository(Order).save(order);

        // Atomic stock decrement with DB-level check to prevent overselling.
        // ANTES: o decremento só rodava quando a leitura em memória mostrava
        // `stock > 0`. Um produto que já tinha chegado a 0 (leitura obsoleta ou
        // esgotado por outra compra) caía FORA do if e o pedido passava sem
        // decrementar → oversell ilimitado a partir do zero. `stock` é sempre
        // número (coluna default 0, não-nulável), então o gate agora é só o
        // `WHERE stock >= $1` do próprio UPDATE — mesma semântica do
        // productsService.decrementStock, inclusive marcando isAvailable=false
        // ao zerar.
        for (const item of items) {
          const result = await manager.query(
            `UPDATE products
                SET stock = stock - $1,
                    "isAvailable" = CASE WHEN stock - $1 <= 0 THEN false ELSE "isAvailable" END
              WHERE id = $2 AND stock >= $1
              RETURNING stock`,
            [item.quantity, item.product.id],
          );
          if (!result || result.length === 0) {
            throw new BadRequestException(
              `Estoque insuficiente para "${item.product.name}". Tente novamente.`,
            );
          }
        }

        // Coupon usage: only increment for non-payment orders (ON_DELIVERY).
        // For online payments, increment after payment is confirmed (handleOrderPaid webhook).
        if (couponEntity && !needsPayment) {
          await this.couponsService.incrementUsage(couponEntity.id);
        }

        return saved;
      },
    );
    savedOrder.store = store;

    if (
      !isPickup &&
      input.deliveryAddress &&
      input.deliveryLatitude &&
      input.deliveryLongitude
    ) {
      this.addressesService
        .saveFromOrder(
          input.deliveryAddress,
          input.deliveryLatitude,
          input.deliveryLongitude,
          customer,
        )
        .catch(() => {});
    }

    if (
      (paymentMethod === 'MERCADO_PAGO' || paymentMethod === 'CREDIT_CARD') &&
      (input.cardId || input.cardToken)
    ) {
      // Pré-autorização: segura o limite mas não cobra ainda
      try {
        const { pagarmeOrderId, status, chargeId } =
          await this.paymentsService.createOrderDirectCharge(
            savedOrder,
            customer,
            input.cardId,
            input.cardToken,
          );
        savedOrder.mpPreferenceId = pagarmeOrderId;
        if (chargeId) savedOrder.preAuthChargeId = chargeId;

        if (status === 'antifraud_review') {
          // Antifraud blocked but acquirer approved — save for manual reprocessing
          savedOrder.status = OrderStatus.PAYMENT_REVIEW;
          await this.ordersRepository.save(savedOrder);

          // Notify support via email
          this.mailService
            .sendAntifraudReviewEmail(
              savedOrder.orderNumber,
              customer.name,
              Number(savedOrder.total),
              chargeId || pagarmeOrderId,
            )
            .catch(() => {});

          // Notify customer
          this.notificationsService
            .sendToAppUser(
              customer.id,
              'Pagamento em analise',
              `Seu pedido #${savedOrder.orderNumber} esta em analise de seguranca. Voce sera notificado quando for aprovado.`,
              { type: 'PAYMENT_REVIEW', orderId: savedOrder.id },
            )
            .catch(() => {});
        } else {
          savedOrder.status = OrderStatus.PENDING;
          await this.ordersRepository.save(savedOrder);
        }
      } catch (err: any) {
        savedOrder.status = OrderStatus.CANCELLED;
        await this.ordersRepository.save(savedOrder);
        // Restaurar estoque
        for (const item of items) {
          if (item.product?.id) {
            await this.productsService.restoreStock(
              item.product.id,
              item.quantity,
            );
          }
        }
        throw new BadRequestException(
          err?.message ||
            'Falha na pré-autorização do cartão. Verifique os dados e tente novamente.',
        );
      }
    } else if (
      paymentMethod === 'MERCADO_PAGO' ||
      paymentMethod === 'CREDIT_CARD'
    ) {
      const { checkoutUrl, preferenceId } =
        await this.paymentsService.createOrderCheckout(savedOrder, customer);
      savedOrder.checkoutUrl = checkoutUrl;
      savedOrder.mpPreferenceId = preferenceId;
      await this.ordersRepository.save(savedOrder);
    } else if (paymentMethod === 'PIX') {
      try {
        const result = await this.paymentsService.createOrderPix(
          savedOrder,
          customer,
        );
        savedOrder.checkoutUrl = result.checkoutUrl;
        savedOrder.mpPreferenceId = result.preferenceId;
        if (result.qrCode) savedOrder.pixQrCode = result.qrCode;
        if (result.qrCodeUrl) savedOrder.pixQrCodeBase64 = result.qrCodeUrl;
        await this.ordersRepository.save(savedOrder);
      } catch (err: any) {
        console.error('PIX checkout generation failed:', err?.message || err);
        throw new BadRequestException(
          err?.message ||
            'Nao foi possivel gerar o pagamento PIX. Tente novamente ou use outro metodo de pagamento.',
        );
      }
    }

    if (store.owner?.id) {
      this.notificationsService
        .sendToVendorUser(
          store.owner.id,
          'Novo pedido!',
          `Pedido #${savedOrder.orderNumber} - R$ ${total.toFixed(2)}`,
          { type: 'NEW_ORDER', orderId: savedOrder.id },
        )
        .catch(() => {});
    }

    if (store.owner?.phone) {
      this.whatsAppService
        .notifyNewOrderToVendor(
          store.owner.phone,
          savedOrder.orderNumber,
          total.toFixed(2),
        )
        .catch(() => {});
    }

    if (savedOrder.customer?.phone) {
      const itemCount = savedOrder.items?.length ?? 0;
      const msg =
        `Olá ${savedOrder.customer.name}! Recebemos seu pedido *#${savedOrder.orderNumber}* na *${store.name}*.\n` +
        `Total: R$${total.toFixed(2)} | ${itemCount} ${itemCount === 1 ? 'item' : 'itens'}\n` +
        `Aguardando confirmação da loja. Responda aqui para consultar o status.`;
      this.whatsAppService.sendText(savedOrder.customer.phone, msg).catch(() => {});
    }

    // Publica o pedido COMPLETO (store.owner/customer/delivery.deliverer) para o
    // filtro de ownership das subscriptions decidir quem é parte, e para os
    // clientes selecionarem campos aninhados sem 500.
    const fullNew = await this.findById(savedOrder.id);
    this.pubSub.publish('orderCreated', { orderCreated: fullNew });
    this.pubSub.publish('orderUpdated', { orderUpdated: fullNew });

    return savedOrder;
  }

  async findStoreById(storeId: string) {
    return this.storesService.findById(storeId);
  }

  async findById(id: string): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: [
        'customer',
        'store',
        'store.owner',
        'items',
        'items.product',
        'delivery',
        'delivery.deliverer',
        'coupon',
      ],
    });
    if (!order) throw new NotFoundException('Pedido nao encontrado');
    return order;
  }

  async findByOrderNumber(orderNumber: string): Promise<Order | null> {
    return this.ordersRepository.findOne({
      where: { orderNumber },
      relations: ['store', 'items', 'items.product'],
    });
  }

  // Perf (F6): paginado (limit/offset). O cap de 500 vira teto do limit.
  async findByCustomer(customerId: string, limit = 20, offset = 0): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { customer: { id: customerId } },
      // 'customer' é @Field(() => AppUser) NÃO-nulável; sem a relation, um
      // `myOrders { customer { ... } }` 500a a lista toda.
      relations: ['store', 'items', 'items.product', 'delivery', 'customer'],
      order: { createdAt: 'DESC' },
      // Error#3: cap de segurança contra carga ilimitada (ver findByStore).
      take: Math.min(Math.max(limit ?? 20, 1), 500),
      skip: Math.max(offset ?? 0, 0),
    });
  }

  async findByStore(storeId: string): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { store: { id: storeId } },
      relations: [
        'store',
        'customer',
        'items',
        'items.product',
        'delivery',
        'delivery.deliverer',
      ],
      order: { createdAt: 'DESC' },
      // Error#3: cap de segurança. Sem limite, uma loja com histórico grande
      // carregava TODOS os pedidos com relações profundas a cada abertura do painel
      // (e a cada mensagem no agente n8n) → pico de memória e query lenta. 500 mais
      // recentes cobre os painéis reais (que filtram por status/data).
      take: 500,
    });
  }

  async getPopularProducts(limit = 12): Promise<any[]> {
    const rows = await this.ordersRepository.query(
      `SELECT p.id, p.name, p.description, p.price, p."promotionalPrice", p."imageUrl",
              p."isAvailable", p."isVariableWeight", p.unit,
              s.id AS "storeId", s.name AS "storeName", s."logoUrl" AS "storeLogoUrl",
              s."isOpen" AS "storeIsOpen",
              c.id AS "categoryId", c.name AS "categoryName",
              SUM(oi.quantity) AS "totalSold"
       FROM order_items oi
       JOIN products p ON oi."productId" = p.id
       JOIN stores s ON p."storeId" = s.id
       LEFT JOIN categories c ON p."categoryId" = c.id
       JOIN orders o ON oi."orderId" = o.id
       WHERE o.status NOT IN ('CANCELLED', 'EXPIRED')
         AND p."isAvailable" = true
         AND p."isActive" = true
         AND s."isActive" = true
         AND o."createdAt" >= NOW() - INTERVAL '30 days'
       GROUP BY p.id, p.name, p.description, p.price, p."promotionalPrice", p."imageUrl",
                p."isAvailable", p."isVariableWeight", p.unit,
                s.id, s.name, s."logoUrl", s."isOpen",
                c.id, c.name
       ORDER BY "totalSold" DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async getReorderSuggestions(customerId: string, limit = 10): Promise<any[]> {
    const rows = await this.ordersRepository.query(
      `SELECT DISTINCT ON (p.id) p.id, p.name, p.description, p.price, p."promotionalPrice", p."imageUrl",
              p."isAvailable",
              s.id AS "storeId", s.name AS "storeName", s."logoUrl" AS "storeLogoUrl",
              s."isOpen" AS "storeIsOpen",
              MAX(o."createdAt") AS "lastOrderedAt"
       FROM order_items oi
       JOIN products p ON oi."productId" = p.id
       JOIN stores s ON p."storeId" = s.id
       JOIN orders o ON oi."orderId" = o.id
       WHERE o."customerId" = $1
         AND o.status NOT IN ('CANCELLED', 'EXPIRED')
         AND p."isAvailable" = true
         AND p."isActive" = true
         AND s."isActive" = true
       GROUP BY p.id, p.name, p.description, p.price, p."promotionalPrice", p."imageUrl",
                p."isAvailable",
                s.id, s.name, s."logoUrl", s."isOpen"
       ORDER BY p.id, "lastOrderedAt" DESC
       LIMIT $2`,
      [customerId, limit],
    );
    return rows;
  }

  async getFrequentStores(customerId: string, limit = 6): Promise<any[]> {
    const rows = await this.ordersRepository.query(
      `SELECT s.id, s.name, s.description, s."logoUrl", s."bannerUrl", s."isOpen",
              s."freeDelivery", s."deliveryFee", s."verificationLevel",
              COUNT(o.id) AS "orderCount",
              MAX(o."createdAt") AS "lastOrderAt"
       FROM orders o
       JOIN stores s ON o."storeId" = s.id
       WHERE o."customerId" = $1
         AND o.status NOT IN ('CANCELLED', 'EXPIRED')
         AND s."isActive" = true
       GROUP BY s.id, s.name, s.description, s."logoUrl", s."bannerUrl", s."isOpen",
                s."freeDelivery", s."deliveryFee", s."verificationLevel"
       ORDER BY "orderCount" DESC, "lastOrderAt" DESC
       LIMIT $2`,
      [customerId, limit],
    );
    return rows;
  }

  async getTopStoresWeekly(limit = 5): Promise<any[]> {
    const rows = await this.ordersRepository.query(
      `SELECT s.id, s.name, s.description, s."logoUrl", s."bannerUrl", s."isOpen",
              s."freeDelivery", s."deliveryFee", s."verificationLevel",
              COUNT(o.id) AS "orderCount",
              COALESCE(SUM(o.total), 0) AS "totalRevenue"
       FROM orders o
       JOIN stores s ON o."storeId" = s.id
       WHERE o.status NOT IN ('CANCELLED', 'EXPIRED')
         AND s."isActive" = true
         AND o."createdAt" >= NOW() - INTERVAL '7 days'
       GROUP BY s.id, s.name, s.description, s."logoUrl", s."bannerUrl", s."isOpen",
                s."freeDelivery", s."deliveryFee", s."verificationLevel"
       ORDER BY "orderCount" DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async expireAwaitingPaymentOrders(): Promise<number> {
    // 30 min matches PIX QR code expiry (expires_in: 1800 in Pagar.me)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const expired = await this.ordersRepository.find({
      where: {
        status: OrderStatus.AWAITING_PAYMENT,
        createdAt: LessThanOrEqual(thirtyMinAgo),
      },
      relations: ['items', 'items.product'],
    });

    for (const order of expired) {
      // updateStatus handles stock restoration for EXPIRED status
      await this.updateStatus(order.id, OrderStatus.EXPIRED);
    }
    return expired.length;
  }

  async findPendingForDelivery(): Promise<Order[]> {
    // Only show READY orders that don't have a deliverer assigned yet
    const orders = await this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.store', 'store')
      .leftJoinAndSelect('order.customer', 'customer')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.product', 'product')
      .leftJoin('order.delivery', 'delivery')
      .where('order.status = :status', { status: OrderStatus.READY })
      .andWhere('(delivery.id IS NULL OR delivery.delivererId IS NULL)')
      // Pedidos de retirada (pickup) não precisam de entregador — não devem
      // aparecer na lista de entregas disponíveis (senão um entregador aceita
      // e ganha um payout de taxa que nunca foi cobrada do cliente).
      .andWhere('order.isPickup = false')
      .orderBy('order.createdAt', 'ASC')
      .getMany();
    return orders;
  }

  async findAllAdmin(): Promise<Order[]> {
    return this.ordersRepository.find({
      relations: [
        'customer',
        'store',
        'items',
        'items.product',
        'delivery',
        'delivery.deliverer',
      ],
      order: { createdAt: 'DESC' },
    });
  }

  async totalCount(): Promise<number> {
    return this.ordersRepository.count();
  }

  async totalRevenue(): Promise<number> {
    const result = await this.ordersRepository
      .createQueryBuilder('order')
      .select('COALESCE(SUM(order.total), 0)', 'total')
      .where('order.status IN (:...statuses)', {
        statuses: [OrderStatus.DELIVERED, OrderStatus.COMPLETED],
      })
      .getRawOne();
    return parseFloat(result.total);
  }

  async countByStatus(): Promise<{ status: string; count: number }[]> {
    return this.ordersRepository
      .createQueryBuilder('order')
      .select('order.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('order.status')
      .getRawMany();
  }

  async ordersByDay(
    days: number = 30,
  ): Promise<{ date: string; count: number; revenue: number }[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const result = await this.ordersRepository
      .createQueryBuilder('order')
      .select("TO_CHAR(order.createdAt, 'YYYY-MM-DD')", 'date')
      .addSelect('COUNT(*)', 'count')
      .addSelect(
        "COALESCE(SUM(CASE WHEN order.status IN ('DELIVERED','COMPLETED') THEN order.total ELSE 0 END), 0)",
        'revenue',
      )
      .where('order.createdAt >= :since', { since })
      .groupBy("TO_CHAR(order.createdAt, 'YYYY-MM-DD')")
      .orderBy('date', 'ASC')
      .getRawMany();
    return result.map((r: any) => ({
      date: r.date,
      count: Number(r.count),
      revenue: parseFloat(r.revenue),
    }));
  }

  async recentOrders(limit: number = 5): Promise<Order[]> {
    return this.ordersRepository.find({
      relations: ['customer', 'store'],
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async topStores(
    limit: number = 5,
  ): Promise<
    {
      storeId: string;
      storeName: string;
      orderCount: number;
      revenue: number;
    }[]
  > {
    return this.ordersRepository
      .createQueryBuilder('order')
      .innerJoin('order.store', 'store')
      .select('store.id', 'storeId')
      .addSelect('store.name', 'storeName')
      .addSelect('COUNT(*)', 'orderCount')
      .addSelect(
        "COALESCE(SUM(CASE WHEN order.status IN ('DELIVERED','COMPLETED') THEN order.total ELSE 0 END), 0)",
        'revenue',
      )
      .groupBy('store.id')
      .addGroupBy('store.name')
      .orderBy('revenue', 'DESC')
      .limit(limit)
      .getRawMany()
      .then((rows) =>
        rows.map((r: any) => ({
          storeId: r.storeId,
          storeName: r.storeName,
          orderCount: Number(r.orderCount),
          revenue: parseFloat(r.revenue),
        })),
      );
  }

  // ─── Confirmação do cliente (recebimento) ─────────────────────────────

  async confirmReceipt(orderId: string, customerId: string): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id: orderId },
      relations: [
        'customer',
        'delivery',
        'delivery.deliverer',
        'store',
        'store.owner',
      ],
    });
    if (!order) throw new NotFoundException('Pedido nao encontrado');
    if (order.customer.id !== customerId) {
      throw new BadRequestException('Voce nao pode confirmar este pedido');
    }
    if (
      order.status !== OrderStatus.DELIVERER_CONFIRMED_DELIVERY &&
      order.status !== OrderStatus.DELIVERED
    ) {
      throw new BadRequestException('Pedido ainda nao foi entregue');
    }
    if (order.customerConfirmedAt) {
      throw new BadRequestException('Recebimento ja confirmado');
    }

    // R#7: claim atômico. ANTES o check de `customerConfirmedAt` e o set eram
    // passos separados; a confirmação do cliente podia rodar junto com a
    // auto-confirmação do scheduler (10min) e ambas passavam, chamando
    // completeOrderWithPayment 2x (o dinheiro é seguro — aquele método tem guard
    // atômico de status — mas gerava "Pedido finalizado" duplicado e trabalho
    // redundante). Só segue quem gravar a data.
    const claim = await this.ordersRepository.manager.query(
      `UPDATE orders SET "customerConfirmedAt" = NOW() WHERE id = $1 AND "customerConfirmedAt" IS NULL RETURNING id`,
      [order.id],
    );
    if (!claim || claim.length === 0) {
      throw new BadRequestException('Recebimento ja confirmado');
    }
    order.customerConfirmedAt = new Date();
    return this.completeOrderWithPayment(order);
  }

  // ─── Cliente nega recebimento → DISPUTED ─────────────────────────────

  async customerDenyDelivery(
    orderId: string,
    customerId: string,
    reason: string,
  ): Promise<Order> {
    const order = await this.findById(orderId);
    if (order.customer.id !== customerId) {
      throw new BadRequestException('Voce nao pode disputar este pedido');
    }
    if (order.status !== OrderStatus.DELIVERER_CONFIRMED_DELIVERY) {
      throw new BadRequestException(
        'Este pedido nao esta aguardando confirmacao de entrega',
      );
    }

    order.disputeReason = reason;
    await this.ordersRepository.save(order);
    return this.updateStatus(order.id, OrderStatus.DISPUTED);
  }

  // ─── Cliente disputa pedido já completado (48h) ──────────────────────

  async disputeCompletedOrder(
    orderId: string,
    customerId: string,
    reason: string,
  ): Promise<Order> {
    const order = await this.findById(orderId);
    if (order.customer.id !== customerId) {
      throw new BadRequestException('Voce nao pode disputar este pedido');
    }
    if (order.status !== OrderStatus.COMPLETED) {
      throw new BadRequestException('Este pedido nao pode ser disputado');
    }

    const completedAt = order.completedAt
      ? new Date(order.completedAt).getTime()
      : 0;
    const hoursSinceCompleted = (Date.now() - completedAt) / (1000 * 60 * 60);
    if (hoursSinceCompleted > 48) {
      throw new BadRequestException(
        'O prazo de 48 horas para reclamacao expirou',
      );
    }

    order.disputeReason = reason;
    await this.ordersRepository.save(order);
    return this.updateStatus(order.id, OrderStatus.DISPUTED);
  }

  async requestCancelDispute(
    orderId: string,
    vendorUserId: string,
  ): Promise<Order> {
    const order = await this.findById(orderId);
    if (order.store?.owner?.id !== vendorUserId) {
      throw new BadRequestException('Voce nao tem permissao para este pedido');
    }
    if (order.status !== OrderStatus.DISPUTED) {
      throw new BadRequestException('Este pedido nao esta em disputa');
    }

    if (order.customer?.id) {
      this.notificationsService
        .sendToAppUser(
          order.customer.id,
          'Solicitação da loja',
          `${order.store.name} pediu para você cancelar a reclamação do pedido #${order.orderNumber}`,
          { type: 'REQUEST_CANCEL_DISPUTE', orderId: order.id },
        )
        .catch(() => {});
    }

    return order;
  }

  async cancelDispute(orderId: string, customerId: string): Promise<Order> {
    const order = await this.findById(orderId);
    if (order.customer.id !== customerId) {
      throw new BadRequestException('Voce nao pode cancelar esta disputa');
    }
    if (order.status !== OrderStatus.DISPUTED) {
      throw new BadRequestException('Este pedido nao esta em disputa');
    }
    order.disputeReason = undefined as any;
    order.disputedAt = undefined as any;
    await this.ordersRepository.save(order);
    return this.updateStatus(order.id, OrderStatus.COMPLETED);
  }

  // ─── Vendedor rejeita pedido ──────────────────────────────────────────

  async rejectOrder(
    orderId: string,
    vendorUserId: string,
    reason: string,
  ): Promise<Order> {
    const order = await this.findById(orderId);
    if (order.store?.owner?.id !== vendorUserId) {
      throw new BadRequestException('Voce nao pode rejeitar este pedido');
    }
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('So pode rejeitar pedidos pendentes');
    }

    order.rejectionReason = reason;
    await this.ordersRepository.save(order);

    // Cancelar pré-autorização ou estornar PIX
    await this.handlePaymentCancellation(order);

    return this.updateStatus(order.id, OrderStatus.REJECTED);
  }

  // ─── Vendedor cancela pedido (antes de sair para entrega) ────────────

  async vendorCancelOrder(
    orderId: string,
    vendorUserId: string,
    reason: string,
  ): Promise<Order> {
    const order = await this.findById(orderId);
    if (order.store?.owner?.id !== vendorUserId) {
      throw new BadRequestException('Voce nao pode cancelar este pedido');
    }

    if (order.delivery) {
      throw new BadRequestException(
        'Nao e possivel cancelar o pedido depois que um entregador aceitou',
      );
    }

    const cancellableStatuses = [
      OrderStatus.PENDING,
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
    ];
    if (!cancellableStatuses.includes(order.status)) {
      throw new BadRequestException(
        'Nao e possivel cancelar o pedido depois que saiu para entrega',
      );
    }

    order.rejectionReason = reason;
    await this.ordersRepository.save(order);

    await this.handlePaymentCancellation(order);

    return this.updateStatus(order.id, OrderStatus.CANCELLED);
  }

  // ─── Vendedor confirma coleta pelo entregador ─────────────────────────

  async vendorConfirmPickup(
    orderId: string,
    vendorUserId: string,
  ): Promise<Order> {
    const order = await this.findById(orderId);
    if (order.store?.owner?.id !== vendorUserId) {
      throw new BadRequestException('Voce nao pode confirmar este pedido');
    }

    // Vendor can confirm when: READY, PICKED_UP, or DELIVERING
    const allowed = [
      OrderStatus.READY,
      OrderStatus.PICKED_UP,
      OrderStatus.DELIVERING,
    ];
    if (!allowed.includes(order.status)) {
      throw new BadRequestException(
        'Pedido precisa estar pronto ou coletado para confirmar coleta',
      );
    }

    // If already DELIVERING, just record timestamp
    if (order.status === OrderStatus.DELIVERING) {
      order.vendorConfirmedPickupAt = new Date();
      return this.ordersRepository.save(order);
    }

    // READY or PICKED_UP → advance to VENDOR_CONFIRMED_PICKUP
    // If deliverer already picked up (PICKED_UP), vendor confirmation advances and then auto-goes to DELIVERING
    const updated = await this.updateStatus(
      order.id,
      OrderStatus.VENDOR_CONFIRMED_PICKUP,
    );

    // If deliverer already confirmed pickup, auto-advance to DELIVERING
    if (order.status === OrderStatus.PICKED_UP) {
      return this.updateStatus(order.id, OrderStatus.DELIVERING);
    }

    return updated;
  }

  // ─── Superadmin resolve disputa ───────────────────────────────────────

  async resolveDispute(
    orderId: string,
    resolution: string,
    superadminId: string,
  ): Promise<Order> {
    // M6: Validate resolution value
    if (
      !['CUSTOMER_FAVOR', 'VENDOR_FAVOR', 'DELIVERER_FAVOR'].includes(
        resolution,
      )
    ) {
      throw new BadRequestException(
        'Resolucao invalida. Use: CUSTOMER_FAVOR, VENDOR_FAVOR ou DELIVERER_FAVOR',
      );
    }

    const order = await this.findById(orderId);
    if (order.status !== OrderStatus.DISPUTED) {
      throw new BadRequestException('Este pedido nao esta em disputa');
    }

    order.disputeResolution = resolution;
    order.disputeResolvedAt = new Date();
    await this.ordersRepository.save(order);

    if (resolution === 'CUSTOMER_FAVOR') {
      // Estorno ao cliente — refundOrder already sets status to CANCELLED
      try {
        await this.paymentsService.refundOrder(orderId);
      } catch (err: any) {
        console.error('Refund on dispute resolution failed:', err?.message);
        // If refund failed, still cancel the order
        order.status = OrderStatus.CANCELLED;
        await this.ordersRepository.save(order);
      }
      // Restore stock (refundOrder doesn't handle this)
      for (const item of order.items) {
        if (item.product) {
          await this.productsService.restoreStock(
            item.product.id,
            item.quantity,
          );
        }
      }
      // Devolve o uso do cupom (mesmo motivo do refundOrder: o refund seta
      // CANCELLED direto, pulando o updateStatus que decrementa). Idempotente.
      if (order.coupon?.id && order.couponCredited) {
        try {
          await this.couponsService.decrementUsage(order.coupon.id);
          await this.ordersRepository.update(order.id, { couponCredited: false });
        } catch (err: any) {
          console.error(
            `Failed to decrement coupon usage for order ${order.id}:`,
            err?.message,
          );
        }
      }
      // Reload and return fresh order
      return this.findById(order.id);
    } else {
      // DELIVERER_FAVOR — settle payment (transfer to vendor + deliverer)
      if (
        order.paymentMethod === 'PIX' ||
        order.paymentMethod === 'CREDIT_CARD'
      ) {
        try {
          await this.paymentsService.settlePayment(order);
        } catch (err: any) {
          // KAN-195: marca a falha em notes (detectavel) — o retry scheduler cobre.
          console.error(
            `Settlement on dispute resolution failed for order #${order.orderNumber}:`,
            err?.message,
          );
          await this.flagSettlementFailure(order.id, err?.message);
        }
      }
      return this.updateStatus(order.id, OrderStatus.COMPLETED);
    }
  }

  // ─── Cancelamento pelo cliente ────────────────────────────────────────

  async cancelByCustomer(orderId: string, customerId: string): Promise<Order> {
    const order = await this.findById(orderId);

    if (order.customer.id !== customerId) {
      throw new BadRequestException('Voce nao pode cancelar este pedido');
    }

    const cancellableStatuses = [
      OrderStatus.AWAITING_PAYMENT,
      OrderStatus.PENDING,
      OrderStatus.ACCEPTED,
    ];
    if (!cancellableStatuses.includes(order.status)) {
      throw new BadRequestException(
        'Este pedido ja esta em preparo e nao pode mais ser cancelado',
      );
    }

    // Cancelar pré-autorização ou estornar pagamento
    await this.handlePaymentCancellation(order);

    // updateStatus already restores stock for CANCELLED
    const saved = await this.updateStatus(
      order.id,
      OrderStatus.CANCELLED,
      order.customer,
    );

    // Notificar vendedor
    if (order.store?.owner?.id) {
      this.notificationsService
        .sendToVendorUser(
          order.store.owner.id,
          `Pedido #${order.orderNumber}`,
          'Cliente cancelou o pedido',
          {
            type: 'ORDER_STATUS',
            orderId: order.id,
            status: OrderStatus.CANCELLED,
          },
        )
        .catch(() => {});
    }

    return saved;
  }

  // ─── Helper: cancelar pagamento (pré-auth ou estorno) ─────────────────

  private async handlePaymentCancellation(order: Order): Promise<void> {
    // Cartão com pré-auth não capturada: cancela pré-auth (libera limite)
    if (order.preAuthChargeId && !order.capturedAt) {
      try {
        await this.paymentsService.cancelPreAuth(order);
      } catch (err: any) {
        console.error('Cancel pre-auth failed:', err?.message);
      }
      return;
    }

    // Cartão já capturado (com split) ou PIX/Checkout: estorno
    if (order.preAuthChargeId && order.capturedAt) {
      try {
        await this.paymentsService.refundOrder(order.id);
      } catch (err: any) {
        console.error('Refund captured charge failed:', err?.message);
      }
      return;
    }

    // PIX ou Checkout já pago (sem pré-auth): estorno
    if (
      order.mpPreferenceId &&
      (order.paymentMethod === 'PIX' || order.paymentMethod === 'CREDIT_CARD')
    ) {
      try {
        await this.paymentsService.refundOrder(order.id);
      } catch (err: any) {
        console.error('Refund on cancel failed:', err?.message);
      }
    }
  }

  // ─── Expirar pedidos PENDING sem resposta do vendedor (10 min) ────────

  async expirePendingOrders(): Promise<number> {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    // KAN-210: a janela de 10 min do vendedor conta a partir de quando o pedido
    // entrou em PENDING/PAYMENT_REVIEW, nao da criacao. So orders PAGOS chegam a
    // esses status (AWAITING_PAYMENT nem entra no filtro), e updatedAt e bumpado
    // exatamente na transicao de pagamento. Antes usava createdAt: um PIX pago
    // >10 min apos a criacao (cliente demorou) nascia PENDING ja "expirado" e era
    // cancelado/estornado antes do vendedor poder aceitar — pedido pago sumia.
    const expiredOrders = await this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.store', 'store')
      .leftJoinAndSelect('store.owner', 'owner')
      .leftJoinAndSelect('order.customer', 'customer')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.product', 'product')
      .where('order.status IN (:...statuses)', {
        statuses: [OrderStatus.PENDING, OrderStatus.PAYMENT_REVIEW],
      })
      .andWhere('order.updatedAt <= :tenMinAgo', { tenMinAgo })
      .getMany();

    for (const order of expiredOrders) {
      try {
        await this.handlePaymentCancellation(order);
        // updateStatus handles stock restoration for EXPIRED status
        await this.updateStatus(order.id, OrderStatus.EXPIRED);

        // Notify customer
        if (order.customer?.id) {
          const wasPaymentReview = order.status === OrderStatus.PAYMENT_REVIEW;
          const title = wasPaymentReview
            ? 'Pagamento não aprovado'
            : 'Pedido não aceito';
          const body = wasPaymentReview
            ? `O pagamento do pedido #${order.orderNumber} não foi aprovado pela análise de segurança. Seu cartão será estornado automaticamente.`
            : `A loja não respondeu a tempo. Seu pagamento será estornado automaticamente. Pedido #${order.orderNumber}`;
          this.notificationsService
            .sendToAppUser(order.customer.id, title, body, {
              type: 'ORDER_STATUS',
              orderId: order.id,
            })
            .catch(() => {});
        }
      } catch (err) {
        console.error(`Failed to expire order ${order.id}:`, err);
      }
    }

    return expiredOrders.length;
  }

  // ─── Auto-avançar pedidos parados em PICKED_UP ou VENDOR_CONFIRMED_PICKUP (5 min) ──

  async autoAdvanceVendorConfirmedPickup(): Promise<number> {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const stuckOrders = await this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.delivery', 'delivery')
      .leftJoinAndSelect('delivery.deliverer', 'deliverer')
      .leftJoinAndSelect('order.store', 'store')
      .leftJoinAndSelect('store.owner', 'owner')
      .leftJoinAndSelect('order.customer', 'customer')
      .where('order.status IN (:...statuses)', {
        statuses: [OrderStatus.VENDOR_CONFIRMED_PICKUP, OrderStatus.PICKED_UP],
      })
      .andWhere('order.updatedAt <= :fiveMinAgo', { fiveMinAgo })
      .getMany();

    for (const order of stuckOrders) {
      try {
        await this.updateStatus(order.id, OrderStatus.DELIVERING);
      } catch (err) {
        console.error(`Auto-advance failed for order ${order.id}:`, err);
      }
    }

    return stuckOrders.length;
  }

  // ─── Auto-confirmar entregas sem resposta do cliente (10 min) ──────────

  async autoConfirmExpiredDeliveries(): Promise<number> {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const expiredOrders = await this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.delivery', 'delivery')
      .leftJoinAndSelect('delivery.deliverer', 'deliverer')
      .leftJoinAndSelect('order.store', 'store')
      .leftJoinAndSelect('store.owner', 'owner')
      .leftJoinAndSelect('order.customer', 'customer')
      .where('order.status = :status', {
        status: OrderStatus.DELIVERER_CONFIRMED_DELIVERY,
      })
      .andWhere('order.delivererConfirmedDeliveryAt <= :tenMinAgo', {
        tenMinAgo,
      })
      .andWhere('order.customerConfirmedAt IS NULL')
      .getMany();

    for (const order of expiredOrders) {
      try {
        order.customerConfirmedAt = new Date();
        await this.ordersRepository.save(order);
        await this.completeOrderWithPayment(order);
      } catch (err) {
        console.error(`Auto-confirm failed for order ${order.id}:`, err);
      }
    }

    return expiredOrders.length;
  }

  // ─── Alertar vendedor se nenhum entregador em 15 min ──────────────────

  async alertNoDeliverer(): Promise<number> {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stuckOrders = await this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.store', 'store')
      .leftJoinAndSelect('store.owner', 'owner')
      .leftJoin('order.delivery', 'delivery')
      .where('order.status = :status', { status: OrderStatus.READY })
      .andWhere('order.updatedAt <= :tenMinAgo', { tenMinAgo })
      .andWhere('delivery.id IS NULL')
      .andWhere('order.isPickup = false')
      .getMany();

    for (const order of stuckOrders) {
      if (order.store?.owner?.id) {
        this.notificationsService
          .sendToVendorUser(
            order.store.owner.id,
            `Pedido #${order.orderNumber}`,
            'Nenhum entregador aceitou este pedido ainda. Considere cancelar ou aguardar.',
            { type: 'NO_DELIVERER', orderId: order.id },
          )
          .catch(() => {});
      }
    }

    return stuckOrders.length;
  }

  // ─── Completar pedido com pagamento (captura cartão / transferência PIX) ──

  // DEV ONLY: simula pagamento (AWAITING_PAYMENT → PENDING)
  async simulatePayment(orderId: string): Promise<Order> {
    const order = await this.findById(orderId);
    if (order.status !== OrderStatus.AWAITING_PAYMENT) {
      throw new BadRequestException('Pedido nao esta em AWAITING_PAYMENT');
    }
    return this.updateStatus(order.id, OrderStatus.PENDING);
  }

  async findDisputed(): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { status: OrderStatus.DISPUTED },
      relations: [
        'customer',
        'store',
        'store.owner',
        'delivery',
        'delivery.deliverer',
        'items',
        'items.product',
      ],
      order: { disputedAt: 'DESC' },
    });
  }

  // KAN-205: Re-tenta settlements que falharam. completeOrderWithPayment marca o
  // pedido COMPLETED e depois chama settlePayment num try/catch que so logava —
  // sem retry, cobranca de cartao nunca era capturada (dinheiro perdido).
  //
  // settlePayment e idempotente (guard atomico UPDATE isSettled=true WHERE
  // isSettled=false): reverte isSettled=false em falha de captura de cartao, e
  // em PIX so fica isSettled=false se NENHUMA transferencia ocorreu — logo,
  // re-chamar aqui e seguro e nao gera pagamento dobrado.
  //
  // Janela de 48h: apos isso o pedido fica isSettled=false para atencao manual
  // do superadmin (evita re-tentar eternamente algo permanentemente quebrado).
  // KAN-195: registra em notes que o settlement falhou, com timestamp e motivo.
  // Combinado com isSettled=false (ainda nao repassado) + status COMPLETED, torna
  // settlements travados detectaveis/consultaveis pela plataforma. Append-only,
  // nao remove no sucesso posterior (isSettled=true ja indica recuperacao).
  private async flagSettlementFailure(orderId: string, message?: string): Promise<void> {
    const marker = `\n[SETTLEMENT_FAILED ${new Date().toISOString()}] ${message || 'unknown'}`;
    try {
      await this.ordersRepository.manager.query(
        `UPDATE orders SET notes = TRIM(COALESCE(notes, '') || $2) WHERE id = $1`,
        [orderId, marker],
      );
    } catch (e: any) {
      console.error(`Failed to flag settlement failure for order ${orderId}:`, e?.message);
    }
  }

  async retryFailedSettlements(): Promise<number> {
    const windowStart = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const pending = await this.ordersRepository.find({
      where: {
        status: OrderStatus.COMPLETED,
        isSettled: false,
        paymentMethod: In(['PIX', 'CREDIT_CARD']),
        completedAt: MoreThanOrEqual(windowStart),
      },
      relations: ['store', 'store.owner', 'delivery', 'delivery.deliverer'],
    });

    let settled = 0;
    for (const order of pending) {
      try {
        await this.paymentsService.settlePayment(order);
        settled++;
      } catch {
        // Continua isSettled=false; sera re-tentado no proximo ciclo (dentro da janela).
      }
    }
    return settled;
  }

  // L9: TODO — ON_DELIVERY orders have no payment guarantee; platform commission is not collected.
  // Consider implementing a post-delivery invoice/billing system for ON_DELIVERY commission collection.
  async completeOrderWithPayment(order: Order): Promise<Order> {
    // Idempotency guard: skip if already completed (race between geolocation + scheduler)
    if (order.status === OrderStatus.COMPLETED) {
      return order;
    }

    // DB-level atomic guard: prevents double settlement via concurrent calls
    const result = await this.ordersRepository.manager.query(
      `UPDATE orders SET status = $1, "completedAt" = NOW() WHERE id = $2 AND status != $1 RETURNING id`,
      [OrderStatus.COMPLETED, order.id],
    );
    if (!result || result.length === 0) {
      // Another call already completed this order
      return this.findById(order.id);
    }

    // Settle payment: transfer vendor and deliverer shares from platform
    if (
      order.paymentMethod === 'PIX' ||
      order.paymentMethod === 'CREDIT_CARD'
    ) {
      try {
        await this.paymentsService.settlePayment(order);
      } catch (err: any) {
        // KAN-195: nao engolir a falha silenciosamente. settlePayment ja reverteu
        // isSettled=false, e o scheduler retryFailedSettlements (KAN-205) re-tenta
        // a cada 60s por 48h. Mas persistimos um marcador detectavel em notes para
        // a plataforma enxergar settlements travados (ex.: pre-auth expirada,
        // vendedor sem recipient) em vez de um "pedido finalizado" sem repasse.
        console.error(`Settlement failed for order #${order.orderNumber}:`, err?.message);
        await this.flagSettlementFailure(order.id, err?.message);
      }
    }

    // Publish and notify (updateStatus normally does this, so replicate key parts)
    const updated = await this.findById(order.id);
    this.pubSub.publish('orderUpdated', { orderUpdated: updated });

    if (updated.customer?.id) {
      this.notificationsService
        .sendToAppUser(
          updated.customer.id,
          `Pedido #${updated.orderNumber}`,
          'Pedido finalizado! Obrigado pela compra.',
          {
            type: 'ORDER_STATUS',
            orderId: updated.id,
            status: OrderStatus.COMPLETED,
          },
        )
        .catch(() => {});
    }

    // Notify vendor (completeOrderWithPayment bypasses updateStatus, so replicate vendor notification)
    if (updated.store?.owner?.id) {
      this.notificationsService
        .sendToVendorUser(
          updated.store.owner.id,
          `Pedido #${updated.orderNumber}`,
          'Pedido finalizado com sucesso!',
          {
            type: 'ORDER_STATUS',
            orderId: updated.id,
            status: OrderStatus.COMPLETED,
          },
        )
        .catch(() => {});
    }

    return updated;
  }

  async refundOrder(orderId: string, vendorUserId: string): Promise<Order> {
    const order = await this.findById(orderId);

    if (order.store?.owner?.id !== vendorUserId) {
      throw new BadRequestException('Voce nao pode estornar este pedido');
    }

    const result = await this.paymentsService.refundOrder(orderId);
    if (!result.success) throw new BadRequestException(result.message);

    // Restore stock
    for (const item of order.items) {
      if (item.product) {
        await this.productsService.restoreStock(item.product.id, item.quantity);
      }
    }

    // Devolve o uso do cupom. refundOrder cancela via paymentsService, que seta
    // CANCELLED direto no banco — pulando updateStatus, onde o decremento de
    // cupom vive. Sem isto, um pedido pago com cupom de uso limitado, ao ser
    // estornado, mantinha o uso consumido para sempre (furava o limite). Mesmo
    // guard idempotente do updateStatus (couponCredited).
    if (order.coupon?.id && order.couponCredited) {
      try {
        await this.couponsService.decrementUsage(order.coupon.id);
        await this.ordersRepository.update(order.id, { couponCredited: false });
      } catch (err: any) {
        console.error(
          `Failed to decrement coupon usage for order ${order.id}:`,
          err?.message,
        );
      }
    }

    const updated = await this.findById(orderId);
    this.pubSub.publish('orderUpdated', { orderUpdated: updated });
    return updated;
  }

  async updateStatus(
    id: string,
    status: OrderStatus,
    user?: AppUser,
  ): Promise<Order> {
    const order = await this.findById(id);

    const allowed = STATUS_TRANSITIONS[order.status];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Nao pode mudar de ${order.status} para ${status}`,
      );
    }

    // R#5: claim ATÔMICO da transição. ANTES a validade era checada contra
    // STATUS_TRANSITIONS[order.status] em memória e o novo status só era gravado
    // no fim — dois cancelamentos concorrentes (ex.: cliente cancela + scheduler
    // expira o mesmo pedido) viam o mesmo `fromStatus`, ambos passavam e cada um
    // restaurava estoque / decrementava cupom (estoque inflado, cupom decrementado
    // 2x). Este UPDATE condicional garante que só UM caller efetua a transição —
    // e portanto os efeitos colaterais abaixo rodam uma única vez.
    const claimFrom = order.status;
    const transitionClaim = await this.ordersRepository.manager.query(
      `UPDATE orders SET status = $2 WHERE id = $1 AND status = $3 RETURNING id`,
      [id, status, claimFrom],
    );
    if (!transitionClaim || transitionClaim.length === 0) {
      throw new BadRequestException(
        `Nao pode mudar de ${claimFrom} para ${status}`,
      );
    }

    if (status === OrderStatus.PICKED_UP && user && !order.delivery) {
      const delivery = this.deliveriesRepository.create({
        order,
        deliverer: user,
      });
      await this.deliveriesRepository.save(delivery);
    }

    if (status === OrderStatus.DELIVERING && order.delivery) {
      order.delivery.pickedUpAt = new Date();
      await this.deliveriesRepository.save(order.delivery);
    }

    if (status === OrderStatus.DELIVERED && order.delivery) {
      order.delivery.deliveredAt = new Date();
      await this.deliveriesRepository.save(order.delivery);
      if (order.store?.id) {
        this.verificationService
          .onSaleCompleted(order.store.id)
          .catch(() => {});
      }
    }

    if (
      status === OrderStatus.CANCELLED ||
      status === OrderStatus.REJECTED ||
      status === OrderStatus.EXPIRED
    ) {
      for (const item of order.items) {
        if (item.product) {
          await this.productsService.restoreStock(
            item.product.id,
            item.quantity,
          );
        }
      }
      // H2: Decrement coupon usage when order is cancelled/rejected/expired
      // KAN-234: so decrementa se o uso foi REALMENTE contabilizado para este
      // pedido. Antes decrementava sempre que houvesse cupom — entao cancelar
      // um pedido de pagamento online que nunca foi pago (e portanto nunca
      // incrementou) liberava um uso extra do cupom, furando o limite. A flag
      // e zerada em seguida para o decremento ser idempotente.
      if (order.coupon?.id && order.couponCredited) {
        try {
          await this.couponsService.decrementUsage(order.coupon.id);
          await this.ordersRepository.update(order.id, { couponCredited: false });
        } catch (err: any) {
          console.error(
            `Failed to decrement coupon usage for order ${order.id}:`,
            err?.message,
          );
        }
      }
    }

    // Timestamps dos novos status
    if (status === OrderStatus.VENDOR_CONFIRMED_PICKUP) {
      order.vendorConfirmedPickupAt = new Date();
    }
    if (status === OrderStatus.DELIVERER_CONFIRMED_DELIVERY) {
      order.delivererConfirmedDeliveryAt = new Date();
    }
    if (status === OrderStatus.COMPLETED) {
      order.completedAt = new Date();
    }
    if (status === OrderStatus.DISPUTED) {
      order.disputedAt = new Date();
    }
    if (status === OrderStatus.REJECTED) {
      order.rejectedAt = new Date();
    }

    const fromStatus = order.status;
    order.status = status;
    const saved = await this.ordersRepository.save(order);

    // Auditoria: registra mudança de status
    const log = this.orderStatusLogRepository.create({
      order: saved,
      fromStatus,
      toStatus: status,
      changedBy: user?.id || 'SYSTEM',
    });
    await this.orderStatusLogRepository.save(log).catch(() => {});

    const statusMessages: Record<string, string> = {
      [OrderStatus.ACCEPTED]: 'Seu pedido foi aceito!',
      [OrderStatus.PREPARING]: 'Seu pedido está sendo preparado',
      [OrderStatus.READY]: 'Seu pedido está pronto!',
      [OrderStatus.VENDOR_CONFIRMED_PICKUP]: 'Seu pedido saiu da loja!',
      [OrderStatus.PICKED_UP]: 'Entregador confirmou a retirada',
      [OrderStatus.DELIVERING]: 'Seu pedido está a caminho!',
      [OrderStatus.DELIVERER_CONFIRMED_DELIVERY]:
        'Seu pedido foi entregue! Confirme o recebimento.',
      [OrderStatus.DELIVERED]: 'Seu pedido foi entregue!',
      [OrderStatus.COMPLETED]: 'Pedido finalizado! Obrigado pela compra.',
      [OrderStatus.CANCELLED]: 'Seu pedido foi cancelado',
      [OrderStatus.REJECTED]: 'A loja não pôde aceitar seu pedido',
      [OrderStatus.EXPIRED]:
        'Seu pedido expirou. O pagamento será estornado automaticamente.',
    };

    if (statusMessages[status] && order.customer?.id) {
      this.notificationsService
        .sendToAppUser(
          order.customer.id,
          `Pedido #${order.orderNumber}`,
          statusMessages[status],
          { type: 'ORDER_STATUS', orderId: order.id, status },
        )
        .catch(() => {});
    }

    // Vendor notifications for status changes
    const vendorMessages: Record<string, string> = {
      [OrderStatus.DELIVERING]: 'O entregador está a caminho do cliente',
      [OrderStatus.DELIVERER_CONFIRMED_DELIVERY]:
        'Entregador confirmou a entrega ao cliente',
      [OrderStatus.COMPLETED]: 'Pedido finalizado com sucesso!',
      [OrderStatus.CANCELLED]: 'O pedido foi cancelado pelo cliente',
      [OrderStatus.DISPUTED]: 'O cliente abriu uma disputa sobre o pedido',
    };

    if (vendorMessages[status] && order.store?.owner?.id) {
      this.notificationsService
        .sendToVendorUser(
          order.store.owner.id,
          `Pedido #${order.orderNumber}`,
          vendorMessages[status],
          { type: 'ORDER_STATUS', orderId: order.id, status },
        )
        .catch(() => {});
    }

    // WhatsApp notifications
    const customerPhone = order.customer?.phone;
    if (customerPhone) {
      if (status === OrderStatus.ACCEPTED) {
        this.whatsAppService
          .notifyOrderConfirmed(
            customerPhone,
            order.orderNumber,
            order.store?.name || '',
          )
          .catch(() => {});
      } else if (status === OrderStatus.READY) {
        this.whatsAppService
          .notifyOrderReady(customerPhone, order.orderNumber)
          .catch(() => {});
      } else if (status === OrderStatus.DELIVERING) {
        const delivererName = order.delivery?.deliverer?.name || 'Entregador';
        this.whatsAppService
          .notifyOrderDelivering(
            customerPhone,
            order.orderNumber,
            delivererName,
          )
          .catch(() => {});
      } else if (status === OrderStatus.DELIVERED) {
        this.whatsAppService
          .notifyOrderDelivered(customerPhone, order.orderNumber)
          .catch(() => {});
      }
    }

    // Re-fetch with full relations for subscription payload
    const full = await this.findById(saved.id);
    this.pubSub.publish('orderUpdated', { orderUpdated: full });

    if (
      status === OrderStatus.READY &&
      this.onOrderReadyCallback &&
      !order.isPickup
    ) {
      this.onOrderReadyCallback(full);
    }

    return saved;
  }

  async adjustItemWeight(
    orderItemId: string,
    actualWeightGrams: number,
    vendorUserId?: string,
  ): Promise<Order> {
    const item = await this.orderItemsRepository.findOne({
      where: { id: orderItemId },
      relations: ['order', 'order.items', 'product'],
    });
    if (!item) throw new NotFoundException('Item nao encontrado');

    const order = await this.findById(item.order.id);

    if (vendorUserId && order.store?.owner?.id !== vendorUserId) {
      throw new BadRequestException(
        'Você não tem permissão para ajustar itens deste pedido.',
      );
    }

    if (
      order.status !== OrderStatus.PENDING &&
      order.status !== OrderStatus.ACCEPTED
    ) {
      throw new BadRequestException(
        'So e possivel ajustar o peso de itens em pedidos PENDING ou ACCEPTED',
      );
    }

    if (!item.product.isVariableWeight) {
      throw new BadRequestException('Este produto nao e de peso variavel');
    }

    item.totalPrice = (Number(item.unitPrice) * actualWeightGrams) / 1000;
    item.weightGrams = actualWeightGrams;
    await this.orderItemsRepository.save(item);

    const updatedOrder = await this.findById(order.id);
    const subtotal = updatedOrder.items.reduce(
      (sum, i) => sum + Number(i.totalPrice),
      0,
    );
    const discount = Number(updatedOrder.discount) || 0;
    updatedOrder.subtotal = subtotal;
    updatedOrder.total = subtotal - discount + Number(updatedOrder.deliveryFee);
    updatedOrder.commissionAmount =
      Math.round(
        (((subtotal - discount) * Number(updatedOrder.commissionPercent)) /
          100) *
          100,
      ) / 100;
    const saved = await this.ordersRepository.save(updatedOrder);

    const fullUpdated = await this.findById(saved.id);
    this.pubSub.publish('orderUpdated', { orderUpdated: fullUpdated });
    return saved;
  }

  private async hasAgeRestrictedProducts(
    items: OrderItemInput[],
  ): Promise<boolean> {
    for (const item of items) {
      const product = await this.productsService.findById(item.productId);
      if (product.category?.requiresAgeVerification) return true;
    }
    return false;
  }
}
