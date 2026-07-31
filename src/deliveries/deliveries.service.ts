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

    // Check if deliverer already has an active delivery (not delivered yet)
    const activeDelivery = await this.deliveriesRepository.findOne({
      where: { deliverer: { id: deliverer.id }, deliveredAt: IsNull() },
      relations: ['order'],
    });
    if (activeDelivery) {
      throw new BadRequestException(
        'Voce ja tem uma entrega em andamento. Finalize-a antes de aceitar outra.',
      );
    }

    const order = await this.ordersService.findById(orderId);

    // Atomic acceptance using DB transaction with row-level lock
    // Prevents race condition when 2 deliverers click at the same time
    const result = await this.deliveriesRepository.manager.transaction(async (manager) => {
      // Lock the order row to prevent concurrent acceptance
      const lockedOrder = await manager.query(
        `SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );

      if (!lockedOrder || lockedOrder.length === 0) {
        throw new BadRequestException('Pedido não encontrado.');
      }

      // O pedido precisa estar READY para ser aceito para entrega. Sem isto, um
      // entregador podia aceitar pedido PENDING/CANCELLED/COMPLETED: travava o
      // cancelamento pelo vendedor, emperrava o pickup (transição inválida) e a
      // delivery com deliveredAt nulo o prendia como "entrega ativa" para sempre.
      if (lockedOrder[0].status !== OrderStatus.READY) {
        throw new BadRequestException(
          'Pedido não está disponível para entrega.',
        );
      }

      // Check if delivery already exists for this order
      const existing = await manager.query(
        `SELECT d.id, d."delivererId" FROM deliveries d WHERE d."orderId" = $1`,
        [orderId],
      );

      if (existing && existing.length > 0) {
        const row = existing[0];
        if (row.delivererId && row.delivererId !== deliverer.id) {
          throw new BadRequestException('Esta entrega já foi aceita por outro entregador.');
        }
        await manager.query(
          `UPDATE deliveries SET "delivererId" = $1, "updatedAt" = NOW() WHERE id = $2`,
          [deliverer.id, row.id],
        );
        return { deliveryId: row.id, isNew: false };
      }

      const inserted = await manager.query(
        `INSERT INTO deliveries ("orderId", "delivererId", "createdAt", "updatedAt") VALUES ($1, $2, NOW(), NOW()) RETURNING id`,
        [orderId, deliverer.id],
      );
      return { deliveryId: inserted[0].id, isNew: true };
    });

    // Fetch full delivery with relations
    const saved = await this.deliveriesRepository.findOneOrFail({
      where: { id: result.deliveryId },
      relations: ['order', 'order.store', 'order.customer', 'deliverer'],
    });

    // Stop the offer cascade — delivery was accepted
    this.offerService.cancelOffer(orderId);

    await this.publishDeliveryUpdate(saved.id);
    // Publish orderUpdated so vendor panel sees the deliverer info
    const updatedOrder = await this.ordersService.findById(orderId);
    this.pubSub.publish('orderUpdated', { orderUpdated: updatedOrder });
    // Status stays at READY — only changes when deliverer confirms pickup (DELIVERING)
    // The order disappears from "Disponíveis" because it now has a delivery record
    this.notifyVendorDeliveryAccepted(order, deliverer);
    return saved;
  }

  // KAN: publica deliveryUpdated sempre com o delivery COMPLETO (order.customer,
  // order.store.owner e deliverer). Necessário para (1) o filtro de ownership da
  // subscription conseguir decidir quem é parte do pedido e (2) clientes poderem
  // selecionar os campos aninhados do pedido sem 500 (campos não-nuláveis).
  // Perf (F5): aceita um delivery ja carregado com o grafo completo (preloaded)
  // para nao repetir o findOne profundo — critico no updateLocation, que roda a
  // cada tick de GPS.
  private async publishDeliveryUpdate(deliveryId: string, preloaded?: Delivery): Promise<void> {
    const full = preloaded ?? await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order', 'order.store', 'order.store.owner', 'order.customer', 'deliverer'],
    });
    if (full) {
      this.pubSub.publish('deliveryUpdated', { deliveryUpdated: full });
    }
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
    // Perf (F5): carrega o grafo completo UMA vez e o reusa na publicacao. Antes
    // cada tick de GPS fazia 2 buscas (findOne raso + findOne profundo com 5
    // relations dentro do publishDeliveryUpdate) — dobro de I/O no caminho mais
    // frequente do rastreio em tempo real.
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order', 'order.store', 'order.store.owner', 'order.customer', 'deliverer'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');

    const wasFirstLocation = delivery.currentLatitude === null;
    delivery.currentLatitude = latitude;
    delivery.currentLongitude = longitude;
    const saved = await this.deliveriesRepository.save(delivery);
    await this.publishDeliveryUpdate(saved.id, saved);

    // First location: notify vendor panel so GPS button appears without F5
    if (wasFirstLocation) {
      const fullOrder = await this.ordersService.findById(delivery.order.id);
      if (fullOrder) {
        this.pubSub.publish('orderUpdated', { orderUpdated: fullOrder });
      }
    }

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

    // Pre-auth stays active — capture happens with split on customer confirmation
    await this.ordersService.updateStatus(order.id, OrderStatus.PICKED_UP);
    const savedDelivery = await this.deliveriesRepository.save(delivery);
    await this.publishDeliveryUpdate(savedDelivery.id);
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

      // KAN-254: este valor e so de tracking, mas divergia do split real. Usava
      // `subtotal - comissao`, ignorando o desconto de cupom — entao um pedido
      // com cupom mostrava aqui um repasse maior do que o vendedor de fato
      // recebe, confundindo relatorio e conferencia.
      //
      // O split real (payments.service.ts `captureWithSplit`) calcula sobre o
      // `total` (que ja tem o desconto aplicado):
      //   entrega externa  -> total - comissao - taxa de entrega
      //   retirada/entrega propria -> total - comissao
      const total = Number(order.total);
      const commission = Number(order.commissionAmount) || 0;
      const hasExternalDelivery =
        !order.store?.hasOwnDelivery && !order.isPickup && deliveryFee > 0;
      const vendorAmount = hasExternalDelivery
        ? total - commission - deliveryFee
        : total - commission;

      if (vendorAmount > 0) {
        delivery.vendorPayoutAmount = vendorAmount;
        // Credit card: payout happens via capture-with-split on customer confirmation
        // PIX: already transferred on settlement
        delivery.vendorPayoutStatus = order.paymentMethod === 'CREDIT_CARD' ? 'pending_capture' : 'paid_on_pickup';
      }

      if (!order.store?.hasOwnDelivery && deliveryFee > 0) {
        delivery.payoutAmount = deliveryFee;
        delivery.payoutStatus = 'pending_confirmation';
      }
    }

    // Muda pra DELIVERER_CONFIRMED_DELIVERY (aguarda confirmação do cliente)
    await this.ordersService.updateStatus(order.id, OrderStatus.DELIVERER_CONFIRMED_DELIVERY);

    const savedDelivery = await this.deliveriesRepository.save(delivery);
    await this.publishDeliveryUpdate(savedDelivery.id);
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
    const deliveries = await this.deliveriesRepository.find({
      where: { deliverer: { id: delivererId } },
      relations: ['order', 'order.store', 'order.customer', 'order.items', 'order.items.product'],
      order: { createdAt: 'DESC' },
      // Perf (F5): era SEM take — o historico vitalicio do entregador (cada
      // entrega com pedido + itens + produtos aninhados) descia inteiro a cada
      // abertura da aba Entregas. 100 cobre ativas + historico recente; myOrders
      // ja tinha cap analogo (500).
      take: 100,
    });
    return deliveries;
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
