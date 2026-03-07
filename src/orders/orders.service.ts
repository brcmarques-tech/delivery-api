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
import { OrderStatus } from '../common/enums';
import { getPlanConfig } from '../common/plan-config';

const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
  [OrderStatus.READY]: [OrderStatus.PICKED_UP, OrderStatus.CANCELLED],
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
  ) {}

  async create(input: CreateOrderInput, customer: User): Promise<Order> {
    const store = await this.storesService.findById(input.storeId);

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

    const deliveryFee = Number(store.deliveryFee);
    const total = subtotal + deliveryFee;

    // Calcula comissao da plataforma baseado no plano do vendedor
    const storeOwner = store.owner;
    const planConfig = getPlanConfig(storeOwner?.vendorPlan);
    const platformCommission = Math.round(subtotal * planConfig.commissionRate * 100) / 100;
    const platformDeliveryFee = planConfig.platformDeliveryFee;

    const order = this.ordersRepository.create({
      orderNumber: `ORD-${Date.now()}`,
      customer,
      store,
      items,
      subtotal,
      deliveryFee,
      total,
      platformCommission,
      platformDeliveryFee,
      deliveryAddress: input.deliveryAddress,
      deliveryLatitude: input.deliveryLatitude,
      deliveryLongitude: input.deliveryLongitude,
      notes: input.notes,
    });

    return this.ordersRepository.save(order);
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
    return this.ordersRepository.save(order);
  }
}
