import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { CreateOrderInput } from './dto/create-order.input';
import { User } from '../users/entities/user.entity';
import { ProductsService } from '../products/products.service';
import { StoresService } from '../stores/stores.service';
import { PaymentsService } from '../payments/payments.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { AddressesService } from '../addresses/addresses.service';
import { OrderStatus } from '../common/enums';

// Callback type for when order becomes READY
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
  ) {}

  private onOrderReadyCallback: OnOrderReadyCallback | null = null;

  onOrderReady(callback: OnOrderReadyCallback) {
    this.onOrderReadyCallback = callback;
  }

  async create(input: CreateOrderInput, customer: User): Promise<Order> {
    const store = await this.storesService.findById(input.storeId);
    const isPickup = input.isPickup || false;

    if (!isPickup && !input.deliveryAddress) {
      throw new BadRequestException('Informe o endereco de entrega');
    }

    let subtotal = 0;
    const items: OrderItem[] = [];

    for (const itemInput of input.items) {
      const product = await this.productsService.findById(itemInput.productId);
      const unitPrice = Number(product.promotionalPrice || product.price);
      const totalPrice = unitPrice * itemInput.quantity;
      subtotal += totalPrice;

      const orderItem = this.orderItemsRepository.create({
        product,
        quantity: itemInput.quantity,
        unitPrice,
        totalPrice,
        notes: itemInput.notes,
      });
      items.push(orderItem);
    }

    let deliveryFee = 0;

    if (!isPickup && input.deliveryLatitude && input.deliveryLongitude) {
      // Check free delivery conditions
      const storeFreeDelivery = store.freeDelivery;
      const freeAbove = store.freeDeliveryAbove ? Number(store.freeDeliveryAbove) : null;

      if (storeFreeDelivery || (freeAbove && subtotal >= freeAbove)) {
        deliveryFee = 0;
      } else {
        // Calculate delivery fee based on distance
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

    const total = subtotal + deliveryFee;

    const storeOwner = store.owner;

    const paymentMethod = input.paymentMethod || 'ON_DELIVERY';

    const vendorMpConnected = storeOwner?.mpConnected ?? false;

    // Vendedor sem MP conectado: só aceita pagamento na entrega
    if (!vendorMpConnected && paymentMethod !== 'ON_DELIVERY') {
      throw new BadRequestException(
        'Esta loja ainda nao aceita pagamentos online. Escolha pagamento na entrega ou retirada.',
      );
    }

    // Vendedor sem MP + sem entrega propria: só permite retirada
    if (!vendorMpConnected && !store.hasOwnDelivery && !isPickup) {
      throw new BadRequestException(
        'Esta loja so aceita retirada no local no momento.',
      );
    }

    // Pagamento na entrega só é permitido para lojas com entrega própria ou retirada
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
      isPickup,
      platformCommission: 0,
      platformDeliveryFee: 0,
      deliveryAddress: isPickup
        ? `${store.street}, ${store.number} - ${store.neighborhood}, ${store.city}`
        : input.deliveryAddress,
      deliveryLatitude: isPickup ? Number(store.latitude) : input.deliveryLatitude,
      deliveryLongitude: isPickup ? Number(store.longitude) : input.deliveryLongitude,
      notes: input.notes,
      paymentMethod,
      status: needsPayment ? OrderStatus.AWAITING_PAYMENT : OrderStatus.PENDING,
    });

    const savedOrder = await this.ordersRepository.save(order);
    // Ensure store with owner relation is available for payment methods (marketplace split)
    savedOrder.store = store;

    // Auto-save delivery address for future use
    if (!isPickup && input.deliveryAddress && input.deliveryLatitude && input.deliveryLongitude) {
      this.addressesService
        .saveFromOrder(input.deliveryAddress, input.deliveryLatitude, input.deliveryLongitude, customer)
        .catch(() => {}); // Don't fail the order if address save fails
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
        // PIX nao funciona no sandbox do Mercado Pago, so em producao
        throw new BadRequestException(
          'PIX nao disponivel no momento. Em ambiente de teste, use Mercado Pago ou pagamento na entrega.',
        );
      }
    }

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

  async platformRevenue(): Promise<number> {
    const result = await this.ordersRepository
      .createQueryBuilder('order')
      .select(
        'COALESCE(SUM(order.platformCommission), 0) + COALESCE(SUM(order.platformDeliveryFee), 0)',
        'total',
      )
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
    return this.ordersRepository.save(order);
  }

  async updateStatus(id: string, status: OrderStatus, user?: User): Promise<Order> {
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
    }

    order.status = status;
    const saved = await this.ordersRepository.save(order);

    // Trigger delivery offer when order is ready (skip for pickup orders)
    if (status === OrderStatus.READY && this.onOrderReadyCallback && !order.isPickup) {
      // Reload with store relation for coordinates
      const full = await this.findById(saved.id);
      this.onOrderReadyCallback(full);
    }

    return saved;
  }
}
