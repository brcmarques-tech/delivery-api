import { Injectable, NotFoundException, BadRequestException, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { Delivery } from './entities/delivery.entity';
import { User } from '../users/entities/user.entity';
import { OrdersService } from '../orders/orders.service';
import { DeliveryOfferService } from './delivery-offer.service';
import { PaymentsService } from '../payments/payments.service';
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
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  onModuleInit() {
    // When an order becomes READY, start the delivery offer cascade
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

  async acceptDelivery(orderId: string, deliverer: User): Promise<Delivery> {
    if (!deliverer.mpConnected) {
      throw new BadRequestException(
        'Conecte sua conta Mercado Pago para aceitar entregas.',
      );
    }

    const order = await this.ordersService.findById(orderId);

    const delivery = this.deliveriesRepository.create({
      order,
      deliverer,
    });

    await this.ordersService.updateStatus(orderId, OrderStatus.PICKED_UP);
    const saved = await this.deliveriesRepository.save(delivery);
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

    // For app deliverer orders with online payment: pay vendor now (escrow release)
    const order = delivery.order;
    if (!order.store?.hasOwnDelivery && order.paymentMethod !== 'ON_DELIVERY') {
      const vendorAmount = Number(order.subtotal);
      if (vendorAmount > 0 && order.store?.owner?.id) {
        const result = await this.paymentsService.transferToVendor(
          order.store.owner.id,
          vendorAmount,
          order.id,
        );

        savedDelivery.vendorPayoutAmount = vendorAmount;
        savedDelivery.vendorPayoutStatus = result.success ? 'completed' : 'failed';
        savedDelivery.vendorPayoutMpId = result.mpId || '';
        await this.deliveriesRepository.save(savedDelivery);
      }
    }

    return savedDelivery;
  }

  async confirmDelivery(deliveryId: string): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order', 'order.store', 'deliverer'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');

    delivery.deliveredAt = new Date();
    await this.ordersService.updateStatus(delivery.order.id, OrderStatus.DELIVERED);

    // For app deliverer: mark payout as pending customer confirmation
    const order = delivery.order;
    if (!order.store?.hasOwnDelivery) {
      const payoutAmount = Number(order.deliveryFee);
      if (payoutAmount > 0) {
        delivery.payoutAmount = payoutAmount;
        delivery.payoutStatus = 'pending_confirmation';
      }
    }

    const savedDelivery2 = await this.deliveriesRepository.save(delivery);
    this.pubSub.publish('deliveryUpdated', { deliveryUpdated: savedDelivery2 });
    return savedDelivery2;
  }

  /** Called when customer confirms receipt or after 10-min auto-confirm */
  async processDelivererPayout(deliveryId: string): Promise<void> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order', 'deliverer'],
    });
    if (!delivery || delivery.payoutStatus !== 'pending_confirmation') return;

    const payoutAmount = Number(delivery.payoutAmount) || Number(delivery.order.deliveryFee);
    if (payoutAmount <= 0) return;

    const result = await this.paymentsService.transferToDeliverer(
      delivery.deliverer.id,
      payoutAmount,
      delivery.order.id,
    );

    delivery.payoutAmount = payoutAmount;
    delivery.payoutStatus = result.success ? 'completed' : 'failed';
    delivery.payoutMpId = result.mpId || '';
    await this.deliveriesRepository.save(delivery);
  }

  /** Find deliveries waiting for customer confirmation that expired (10 min) */
  async findExpiredPendingConfirmations(): Promise<Delivery[]> {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    return this.deliveriesRepository
      .createQueryBuilder('delivery')
      .leftJoinAndSelect('delivery.order', 'order')
      .leftJoinAndSelect('delivery.deliverer', 'deliverer')
      .where('delivery.deliveredAt IS NOT NULL')
      .andWhere('delivery.deliveredAt <= :tenMinAgo', { tenMinAgo })
      .andWhere('delivery.payoutStatus = :status', { status: 'pending_confirmation' })
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
