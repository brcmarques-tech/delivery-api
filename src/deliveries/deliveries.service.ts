import { Injectable, NotFoundException, BadRequestException, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { Delivery } from './entities/delivery.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { OrdersService } from '../orders/orders.service';
import { DeliveryOfferService } from './delivery-offer.service';
import { OrderStatus } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';

@Injectable()
export class DeliveriesService implements OnModuleInit {
  constructor(
    @InjectRepository(Delivery)
    private deliveriesRepository: Repository<Delivery>,
    @Inject(forwardRef(() => OrdersService))
    private ordersService: OrdersService,
    private offerService: DeliveryOfferService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  onModuleInit() {
    this.ordersService.onOrderReady((order) => {
      const store = order.store;
      if (!store) return;
      this.offerService.startOffer({
        id: order.id,
        orderNumber: order.orderNumber,
        storeLat: Number(store.latitude),
        storeLng: Number(store.longitude),
        storeAddress: `${store.street}, ${store.number} - ${store.neighborhood}`,
        deliveryAddress: order.deliveryAddress,
        deliveryFee: Number(order.deliveryFee),
        itemCount: order.items?.length || 0,
      });
    });
  }

  async acceptDelivery(orderId: string, deliverer: AppUser): Promise<Delivery> {
    if (!deliverer.paymentConnected) {
      throw new BadRequestException(
        'Cadastre sua conta de recebimento para aceitar entregas.',
      );
    }

    const order = await this.ordersService.findById(orderId);

    const delivery = this.deliveriesRepository.create({
      order,
      deliverer,
    });

    const saved = await this.deliveriesRepository.save(delivery);
    await this.ordersService.updateStatus(orderId, OrderStatus.PICKED_UP);
    this.pubSub.publish('deliveryUpdated', { deliveryUpdated: saved });
    return saved;
  }

  async updateLocation(
    deliveryId: string,
    latitude: number,
    longitude: number,
  ): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');

    delivery.currentLatitude = latitude;
    delivery.currentLongitude = longitude;
    const saved = await this.deliveriesRepository.save(delivery);
    this.pubSub.publish('deliveryUpdated', { deliveryUpdated: saved });
    return saved;
  }

  async confirmPickup(deliveryId: string): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order', 'order.store', 'order.store.owner'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');

    delivery.pickedUpAt = new Date();
    await this.ordersService.updateStatus(delivery.order.id, OrderStatus.DELIVERING);
    const savedDelivery = await this.deliveriesRepository.save(delivery);
    this.pubSub.publish('deliveryUpdated', { deliveryUpdated: savedDelivery });
    return savedDelivery;
  }

  async confirmDelivery(deliveryId: string): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order', 'order.store', 'order.store.owner', 'deliverer'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');

    delivery.deliveredAt = new Date();
    await this.ordersService.updateStatus(delivery.order.id, OrderStatus.DELIVERED);

    const order = delivery.order;

    // With Pagar.me split, all payments are distributed automatically at transaction time.
    // No manual transfers needed. Just record the amounts for tracking.
    if (order.paymentMethod !== 'ON_DELIVERY') {
      const deliveryFee = Number(order.deliveryFee);
      const vendorAmount = Number(order.subtotal) - Number(order.commissionAmount);

      if (vendorAmount > 0) {
        delivery.vendorPayoutAmount = vendorAmount;
        delivery.vendorPayoutStatus = 'split_auto';
      }

      if (!order.store?.hasOwnDelivery && deliveryFee > 0) {
        delivery.payoutAmount = deliveryFee;
        delivery.payoutStatus = 'split_auto'; // Pagar.me split handles this automatically
      }
    }

    const savedDelivery2 = await this.deliveriesRepository.save(delivery);
    this.pubSub.publish('deliveryUpdated', { deliveryUpdated: savedDelivery2 });
    return savedDelivery2;
  }

  async findExpiredPendingConfirmations(): Promise<Delivery[]> {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    return this.deliveriesRepository
      .createQueryBuilder('delivery')
      .leftJoinAndSelect('delivery.order', 'order')
      .leftJoinAndSelect('delivery.deliverer', 'deliverer')
      .where('delivery.deliveredAt IS NOT NULL')
      .andWhere('delivery.deliveredAt <= :tenMinAgo', { tenMinAgo })
      .andWhere('order.customerConfirmedAt IS NULL')
      .getMany();
  }

  async findByDeliverer(delivererId: string): Promise<Delivery[]> {
    return this.deliveriesRepository.find({
      where: { deliverer: { id: delivererId } },
      relations: ['order', 'order.store', 'order.customer'],
      order: { createdAt: 'DESC' },
    });
  }

  async findAllAdmin(): Promise<Delivery[]> {
    return this.deliveriesRepository.find({
      relations: ['order', 'order.store', 'order.customer', 'deliverer'],
      order: { createdAt: 'DESC' },
    });
  }

  async totalCount(): Promise<number> {
    return this.deliveriesRepository.count();
  }

  async completedCount(): Promise<number> {
    return this.deliveriesRepository.count({
      where: { deliveredAt: Not(IsNull()) },
    });
  }

  async activeCount(): Promise<number> {
    return this.deliveriesRepository.count({
      where: { deliveredAt: IsNull() },
    });
  }
}
