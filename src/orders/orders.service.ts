import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { CreateOrderInput } from './dto/create-order.input';
import { User } from '../users/entities/user.entity';
import { ProductsService } from '../products/products.service';
import { StoresService } from '../stores/stores.service';
import { OrderStatus } from '../common/enums';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
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

    const order = this.ordersRepository.create({
      orderNumber: `ORD-${Date.now()}`,
      customer,
      store,
      items,
      subtotal,
      deliveryFee,
      total,
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

  async updateStatus(id: string, status: OrderStatus): Promise<Order> {
    const order = await this.findById(id);
    order.status = status;
    return this.ordersRepository.save(order);
  }
}
