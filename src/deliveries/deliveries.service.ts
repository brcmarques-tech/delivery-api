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
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class DeliveriesService implements OnModuleInit {
  constructor(
    @InjectRepository(Delivery)
    private deliveriesRepository: Repository<Delivery>,
    @Inject(forwardRef(() => OrdersService))
    private ordersService: OrdersService,
    private offerService: DeliveryOfferService,
    private notificationsService: NotificationsService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {}

  onModuleInit() {
    this.ordersService.onOrderReady((order) => {
      const store = order.store;
      if (!store) return;
      this.offerService.startOffer({
        id: order.id,
        customerId: order.customer?.id || '',
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

    // Check if delivery already exists for this order (e.g. from offer system)
    const existing = await this.deliveriesRepository.findOne({
      where: { order: { id: orderId } },
      relations: ['order', 'deliverer'],
    });

    if (existing) {
      // If already assigned to another deliverer, reject
      if (existing.deliverer && existing.deliverer.id !== deliverer.id) {
        throw new BadRequestException('Esta entrega já foi aceita por outro entregador.');
      }
      // Assign this deliverer to existing delivery
      existing.deliverer = deliverer;
      const saved = await this.deliveriesRepository.save(existing);
      this.pubSub.publish('deliveryUpdated', { deliveryUpdated: saved });
      // Muda status para tirar de "Disponíveis" imediatamente
      await this.ordersService.updateStatus(orderId, OrderStatus.VENDOR_CONFIRMED_PICKUP);
      this.notifyVendorDeliveryAccepted(order, deliverer);
      return saved;
    }

    const delivery = this.deliveriesRepository.create({
      order,
      deliverer,
    });

    const saved = await this.deliveriesRepository.save(delivery);
    this.pubSub.publish('deliveryUpdated', { deliveryUpdated: saved });
    // Muda status para tirar de "Disponíveis" imediatamente
    await this.ordersService.updateStatus(orderId, OrderStatus.VENDOR_CONFIRMED_PICKUP);
    this.notifyVendorDeliveryAccepted(order, deliverer);
    return saved;
  }

  private notifyVendorDeliveryAccepted(order: any, deliverer: AppUser) {
    const storeOwnerId = order.store?.owner?.id || order.store?.ownerId;
    if (!storeOwnerId) return;
    this.notificationsService.sendToVendorUser(
      storeOwnerId,
      `Pedido #${order.orderNumber}`,
      `Entregador ${deliverer.name} aceitou a entrega!`,
      { type: 'DELIVERY_ACCEPTED', orderId: order.id },
    ).catch(() => {});
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

  // Entregador confirma que pegou o pedido
  async confirmPickup(deliveryId: string, delivererId: string): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order', 'order.store', 'order.store.owner', 'deliverer'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');
    if (delivery.deliverer?.id !== delivererId) {
      throw new BadRequestException('Esta entrega não pertence a você.');
    }

    const order = delivery.order;

    delivery.pickedUpAt = new Date();

    // Capturar pré-autorização do cartão (sem split — tudo pra plataforma)
    // Settlement (transfers) happens after delivery is confirmed
    if (order.preAuthChargeId) {
      try {
        await this.ordersService.captureCardOnPickup(order.id);
      } catch (err: any) {
        console.error('Capture on pickup failed:', err?.message);
        if (order.store?.owner?.id) {
          this.notificationsService.sendToVendorUser(
            order.store.owner.id,
            'Alerta: falha na captura do pagamento',
            `O pagamento do pedido #${order.orderNumber} falhou na captura. Verifique no painel do Pagar.me.`,
            { type: 'CAPTURE_FAILED', orderId: order.id },
          ).catch(() => {});
        }
      }
    }

    await this.ordersService.updateStatus(order.id, OrderStatus.DELIVERING);
    const savedDelivery = await this.deliveriesRepository.save(delivery);
    this.pubSub.publish('deliveryUpdated', { deliveryUpdated: savedDelivery });
    return savedDelivery;
  }

  // Entregador confirma que entregou pro cliente
  async confirmDelivery(deliveryId: string, delivererId: string): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order', 'order.store', 'order.store.owner', 'deliverer'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');
    if (delivery.deliverer?.id !== delivererId) {
      throw new BadRequestException('Esta entrega não pertence a você.');
    }

    delivery.deliveredAt = new Date();

    const order = delivery.order;

    // Registrar valores para tracking
    if (order.paymentMethod !== 'ON_DELIVERY') {
      const deliveryFee = Number(order.deliveryFee);
      const vendorAmount = Number(order.subtotal) - Number(order.commissionAmount);

      if (vendorAmount > 0) {
        delivery.vendorPayoutAmount = vendorAmount;
        delivery.vendorPayoutStatus = 'paid_on_pickup';
      }

      if (!order.store?.hasOwnDelivery && deliveryFee > 0) {
        delivery.payoutAmount = deliveryFee;
        delivery.payoutStatus = 'pending_confirmation';
      }
    }

    // Muda pra DELIVERER_CONFIRMED_DELIVERY (aguarda confirmação do cliente)
    await this.ordersService.updateStatus(order.id, OrderStatus.DELIVERER_CONFIRMED_DELIVERY);

    const savedDelivery = await this.deliveriesRepository.save(delivery);
    this.pubSub.publish('deliveryUpdated', { deliveryUpdated: savedDelivery });
    return savedDelivery;
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
