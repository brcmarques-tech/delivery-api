import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { CreateOrderInput } from './dto/create-order.input';
import { AppUser } from '../users/entities/app-user.entity';
import { ProductsService } from '../products/products.service';
import { StoresService } from '../stores/stores.service';
import { PaymentsService } from '../payments/payments.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { AddressesService } from '../addresses/addresses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CouponsService } from '../coupons/coupons.service';
import { VerificationService } from '../stores/verification.service';
import { OrderStatus } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

type OnOrderReadyCallback = (order: Order) => void;

const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.AWAITING_PAYMENT]: [OrderStatus.PENDING, OrderStatus.CANCELLED],
  [OrderStatus.PENDING]: [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
  [OrderStatus.READY]: [OrderStatus.PICKED_UP, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.PICKED_UP]: [OrderStatus.DELIVERING],
  [OrderStatus.DELIVERING]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
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
    private productsService: ProductsService,
    private storesService: StoresService,
    private paymentsService: PaymentsService,
    private platformConfigService: PlatformConfigService,
    private addressesService: AddressesService,
    private notificationsService: NotificationsService,
    private couponsService: CouponsService,
    @Inject(forwardRef(() => VerificationService))
    private verificationService: VerificationService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  private onOrderReadyCallback: OnOrderReadyCallback | null = null;

  onOrderReady(callback: OnOrderReadyCallback) {
    this.onOrderReadyCallback = callback;
  }

  async create(input: CreateOrderInput, customer: AppUser): Promise<Order> {
    const store = await this.storesService.findById(input.storeId);
    const isPickup = input.isPickup || false;

    if (!isPickup && !input.deliveryAddress) {
      throw new BadRequestException('Informe o endereco de entrega');
    }

    let subtotal = 0;
    const items: OrderItem[] = [];

    for (const itemInput of input.items) {
      const product = await this.productsService.findById(itemInput.productId);
      if (product.stock > 0 && product.stock < itemInput.quantity) {
        throw new BadRequestException(
          `Estoque insuficiente para "${product.name}". Disponivel: ${product.stock}`,
        );
      }
    }

    for (const itemInput of input.items) {
      const product = await this.productsService.findById(itemInput.productId);
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

    let deliveryFee = 0;

    if (!isPickup && input.deliveryLatitude && input.deliveryLongitude) {
      const storeFreeDelivery = store.freeDelivery;
      const freeAbove = store.freeDeliveryAbove ? Number(store.freeDeliveryAbove) : null;

      if (storeFreeDelivery || (freeAbove && subtotal >= freeAbove)) {
        deliveryFee = 0;
      } else {
        const pricePerKm = await this.platformConfigService.getDeliveryPricePerKm();
        const basePrice = await this.platformConfigService.getDeliveryBasePrice();
        const R = 6371;
        const dLat = (input.deliveryLatitude - Number(store.latitude)) * Math.PI / 180;
        const dLng = (input.deliveryLongitude - Number(store.longitude)) * Math.PI / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(Number(store.latitude) * Math.PI / 180) *
            Math.cos(input.deliveryLatitude * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distanceKm = R * c;
        deliveryFee = Math.round((basePrice + distanceKm * pricePerKm) * 100) / 100;
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
      );
      discount = result.discount;
      couponCode = result.coupon.code;
      couponEntity = result.coupon;
    }

    const total = subtotal - discount + deliveryFee;

    const storeOwner = store.owner;
    const vendorPlan = storeOwner?.vendorPlan || 'FREE';
    const planConfig = await this.platformConfigService.getPlanConfig(vendorPlan);
    let commissionPercent = planConfig.commissionPercent;

    if (
      store.commissionReductionPercent > 0 &&
      store.commissionReductionExpiresAt &&
      new Date(store.commissionReductionExpiresAt) > new Date()
    ) {
      commissionPercent = Math.max(0, commissionPercent - Number(store.commissionReductionPercent));
    }

    const commissionAmount = Math.round(((subtotal - discount) * commissionPercent) / 100 * 100) / 100;

    const paymentMethod = input.paymentMethod || 'ON_DELIVERY';

    const vendorMpConnected = storeOwner?.mpConnected ?? false;

    if (!vendorMpConnected && paymentMethod !== 'ON_DELIVERY') {
      throw new BadRequestException(
        'Esta loja ainda nao aceita pagamentos online. Escolha pagamento na entrega ou retirada.',
      );
    }

    if (!vendorMpConnected && !store.hasOwnDelivery && !isPickup) {
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

    const order = this.ordersRepository.create({
      orderNumber: `ORD-${Date.now()}`,
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
      deliveryLatitude: isPickup ? Number(store.latitude) : input.deliveryLatitude,
      deliveryLongitude: isPickup ? Number(store.longitude) : input.deliveryLongitude,
      notes: input.notes,
      paymentMethod,
      couponCode,
      discount,
      coupon: couponEntity,
      status: needsPayment ? OrderStatus.AWAITING_PAYMENT : OrderStatus.PENDING,
    });

    const savedOrder = await this.ordersRepository.save(order);
    savedOrder.store = store;

    if (couponEntity) {
      await this.couponsService.incrementUsage(couponEntity.id);
    }

    for (const item of items) {
      if (item.product.stock > 0) {
        await this.productsService.decrementStock(item.product.id, item.quantity);
      }
    }

    if (!isPickup && input.deliveryAddress && input.deliveryLatitude && input.deliveryLongitude) {
      this.addressesService
        .saveFromOrder(input.deliveryAddress, input.deliveryLatitude, input.deliveryLongitude, customer)
        .catch(() => {});
    }

    if (paymentMethod === 'MERCADO_PAGO') {
      const { checkoutUrl, preferenceId } = await this.paymentsService.createOrderCheckout(savedOrder, customer);
      savedOrder.checkoutUrl = checkoutUrl;
      savedOrder.mpPreferenceId = preferenceId;
      await this.ordersRepository.save(savedOrder);
    } else if (paymentMethod === 'PIX') {
      try {
        const { qrCode, qrCodeBase64 } = await this.paymentsService.createOrderPix(savedOrder, customer);
        savedOrder.pixQrCode = qrCode;
        savedOrder.pixQrCodeBase64 = qrCodeBase64;
        await this.ordersRepository.save(savedOrder);
      } catch (err: any) {
        throw new BadRequestException(
          'PIX nao disponivel no momento. Em ambiente de teste, use Mercado Pago ou pagamento na entrega.',
        );
      }
    }

    if (store.owner?.id) {
      this.notificationsService.sendToVendorUser(
        store.owner.id,
        'Novo pedido!',
        `Pedido #${savedOrder.orderNumber} - R$ ${total.toFixed(2)}`,
        { type: 'NEW_ORDER', orderId: savedOrder.id },
      ).catch(() => {});
    }

    this.pubSub.publish('orderCreated', { orderCreated: savedOrder });
    this.pubSub.publish('orderUpdated', { orderUpdated: savedOrder });

    return savedOrder;
  }

  async findById(id: string): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['customer', 'store', 'items', 'items.product', 'delivery', 'delivery.deliverer'],
    });
    if (!order) throw new NotFoundException('Pedido nao encontrado');
    return order;
  }

  async findByCustomer(customerId: string): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { customer: { id: customerId } },
      relations: ['store', 'items', 'items.product', 'delivery'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByStore(storeId: string): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { store: { id: storeId } },
      relations: ['customer', 'items', 'items.product', 'delivery'],
      order: { createdAt: 'DESC' },
    });
  }

  async findPendingForDelivery(): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { status: OrderStatus.READY },
      relations: ['store', 'customer'],
      order: { createdAt: 'ASC' },
    });
  }

  async findAllAdmin(): Promise<Order[]> {
    return this.ordersRepository.find({
      relations: ['customer', 'store', 'items', 'items.product', 'delivery', 'delivery.deliverer'],
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
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
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

  async confirmReceipt(orderId: string, customerId: string): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id: orderId },
      relations: ['customer', 'delivery', 'delivery.deliverer'],
    });
    if (!order) throw new NotFoundException('Pedido nao encontrado');
    if (order.customer.id !== customerId) {
      throw new BadRequestException('Voce nao pode confirmar este pedido');
    }
    if (order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException('Pedido ainda nao foi entregue');
    }
    if (order.customerConfirmedAt) {
      throw new BadRequestException('Recebimento ja confirmado');
    }

    order.customerConfirmedAt = new Date();
    const saved = await this.ordersRepository.save(order);
    this.pubSub.publish('orderUpdated', { orderUpdated: saved });
    return saved;
  }

  async updateStatus(id: string, status: OrderStatus, user?: AppUser): Promise<Order> {
    const order = await this.findById(id);

    const allowed = STATUS_TRANSITIONS[order.status];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Nao pode mudar de ${order.status} para ${status}`,
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
        this.verificationService.onSaleCompleted(order.store.id).catch(() => {});
      }
    }

    if (status === OrderStatus.CANCELLED) {
      for (const item of order.items) {
        if (item.product) {
          await this.productsService.restoreStock(item.product.id, item.quantity);
        }
      }
    }

    order.status = status;
    const saved = await this.ordersRepository.save(order);

    const statusMessages: Record<string, string> = {
      [OrderStatus.ACCEPTED]: 'Seu pedido foi aceito!',
      [OrderStatus.PREPARING]: 'Seu pedido esta sendo preparado',
      [OrderStatus.READY]: 'Seu pedido esta pronto!',
      [OrderStatus.PICKED_UP]: 'Entregador saiu com seu pedido',
      [OrderStatus.DELIVERING]: 'Seu pedido esta a caminho!',
      [OrderStatus.DELIVERED]: 'Seu pedido foi entregue!',
      [OrderStatus.CANCELLED]: 'Seu pedido foi cancelado',
    };

    if (statusMessages[status] && order.customer?.id) {
      this.notificationsService.sendToAppUser(
        order.customer.id,
        `Pedido #${order.orderNumber}`,
        statusMessages[status],
        { type: 'ORDER_STATUS', orderId: order.id, status },
      ).catch(() => {});
    }

    this.pubSub.publish('orderUpdated', { orderUpdated: saved });

    if (status === OrderStatus.READY && this.onOrderReadyCallback && !order.isPickup) {
      const full = await this.findById(saved.id);
      this.onOrderReadyCallback(full);
    }

    return saved;
  }

  async adjustItemWeight(orderItemId: string, actualWeightGrams: number): Promise<Order> {
    const item = await this.orderItemsRepository.findOne({
      where: { id: orderItemId },
      relations: ['order', 'order.items', 'product'],
    });
    if (!item) throw new NotFoundException('Item nao encontrado');

    const order = await this.findById(item.order.id);

    if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.ACCEPTED) {
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
    const subtotal = updatedOrder.items.reduce((sum, i) => sum + Number(i.totalPrice), 0);
    updatedOrder.subtotal = subtotal;
    updatedOrder.total = subtotal + Number(updatedOrder.deliveryFee);
    const saved = await this.ordersRepository.save(updatedOrder);

    this.pubSub.publish('orderUpdated', { orderUpdated: saved });
    return saved;
  }
}
