import { Injectable, NotFoundException, BadRequestException, OnModuleInit, Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In, IsNull } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { Delivery } from './entities/delivery.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { OrdersService } from '../orders/orders.service';
import { DeliveryCodesService } from '../orders/delivery-codes.service';
import { DeliveryOfferService } from './delivery-offer.service';
import { OrderStatus } from '../common/enums';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../config/platform-config.service';

@Injectable()
export class DeliveriesService implements OnModuleInit {
  constructor(
    @InjectRepository(Delivery)
    private deliveriesRepository: Repository<Delivery>,
    @Inject(forwardRef(() => OrdersService))
    private ordersService: OrdersService,
    private offerService: DeliveryOfferService,
    private notificationsService: NotificationsService,
    private platformConfigService: PlatformConfigService,
    @Inject(PUB_SUB) private pubSub: PubSub,
    // Garantia de entrega por códigos: o código do entregador nasce no aceite
    // da corrida, que acontece aqui.
    @Inject(forwardRef(() => DeliveryCodesService))
    private deliveryCodesService: DeliveryCodesService,
  ) {}

  private readonly logger = new Logger(DeliveriesService.name);

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

    // Check if deliverer already has an active delivery (not delivered yet).
    //
    // BUGFIX: a checagem era so `deliveredAt IS NULL`, e existem caminhos que
    // levam o PEDIDO a um estado terminal sem nunca fechar a ENTREGA — estorno
    // pelo vendedor/painel do Pagar.me, cancelamento, expiracao. A linha ficava
    // orfa (deliveredAt nulo pra sempre) e o entregador nao conseguia mais
    // aceitar NENHUMA entrega: ficava permanentemente fora do trabalho, sem ter
    // feito nada errado e sem forma de destravar pelo app. (Confirmado em dados
    // reais: pedido COMPLETED com a entrega ainda sem deliveredAt.)
    //
    // A regra continua a mesma — um entregador so leva uma entrega por vez. So
    // deixamos de contar como "em andamento" a entrega cujo pedido ja acabou.
    const activeDelivery = await this.deliveriesRepository.findOne({
      where: {
        deliverer: { id: deliverer.id },
        deliveredAt: IsNull(),
        order: {
          status: Not(
            In([
              OrderStatus.COMPLETED,
              OrderStatus.CANCELLED,
              OrderStatus.REJECTED,
              OrderStatus.EXPIRED,
              OrderStatus.DISPUTED,
            ]),
          ),
        },
      },
      relations: ['order'],
    });
    if (activeDelivery) {
      throw new BadRequestException(
        'Voce ja tem uma entrega em andamento. Finalize-a antes de aceitar outra.',
      );
    }

    const order = await this.ordersService.findById(orderId);

    // ALTO (auditoria 2026-08-23): AUTOENTREGA. Sem esta checagem, um cliente com
    // conta de entregador aceitava a PRÓPRIA entrega — passava a controlar as duas
    // pontas da "prova de entrega" (confirma a coleta, o scheduler avança, confirma
    // a entrega e o próprio recebimento -> COMPLETED, e ~90% da taxa volta ao bolso
    // dele) e ainda podia abrir disputa em 48h para estornar tudo com a mercadoria
    // em mãos. O dono da loja (owner) também não pode ser o entregador do próprio
    // pedido. (customer e deliverer são a mesma tabela app_users; owner é vendor_users.)
    if (order.customer?.id && order.customer.id === deliverer.id) {
      throw new BadRequestException('Você não pode aceitar a entrega do seu próprio pedido.');
    }
    if (order.store?.owner?.id && order.store.owner.id === deliverer.id) {
      throw new BadRequestException('O dono da loja não pode ser o entregador do próprio pedido.');
    }

    // CRITICO (auditoria 2026-08-23): pedido de retirada ou de loja com frota
    // própria não remunera o entregador do app no settlePayment. A listagem já os
    // exclui, mas aceitar por orderId direto contornava o filtro — bloqueio aqui.
    if (order.isPickup) {
      throw new BadRequestException('Pedido de retirada não precisa de entregador.');
    }
    if (order.store?.hasOwnDelivery) {
      throw new BadRequestException('Esta loja faz as próprias entregas.');
    }

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

      // A regra "um entregador leva uma entrega por vez" era checada FORA desta
      // transacao, sem lock no entregador, e nao era revalidada aqui dentro.
      // Dois `acceptDelivery` em paralelo (dois toques no app, ou reenvio por
      // timeout) para pedidos DIFERENTES liam ambos zero entregas ativas, e
      // depois travavam linhas de `orders` distintas — sem conflito entre si.
      // Resultado: uma pessoa com duas entregas simultaneas, dois pedidos fora
      // da fila e duas lojas esperando uma coleta que so pode acontecer em
      // serie. O lock no proprio entregador serializa as duas tentativas.
      await manager.query(`SELECT id FROM app_users WHERE id = $1 FOR UPDATE`, [
        deliverer.id,
      ]);
      const jaTem = await manager.query(
        `SELECT d.id
           FROM deliveries d
           JOIN orders o ON o.id = d."orderId"
          WHERE d."delivererId" = $1
            AND d."deliveredAt" IS NULL
            AND o.status NOT IN ('COMPLETED','CANCELLED','REJECTED','EXPIRED','DISPUTED')
          LIMIT 1`,
        [deliverer.id],
      );
      if (jaTem && jaTem.length > 0) {
        throw new BadRequestException(
          'Voce ja tem uma entrega em andamento. Finalize-a antes de aceitar outra.',
        );
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

    // Garantia de entrega por códigos: agora que existe entregador, ele ganha o
    // SEU código — o que o lojista vai digitar na coleta para provar que
    // entregou o pedido à pessoa certa. Antes deste ponto não há entregador, e
    // por isso este é o único lugar onde esse código pode nascer.
    //
    // Não bloqueia o aceite se falhar: o entregador não pode perder a corrida
    // por causa disso, e a geração é idempotente (claim atômico), então o
    // caminho de recuperação é simplesmente chamar de novo.
    await this.deliveryCodesService
      .gerarCodigoDoEntregador(orderId)
      .catch((err: any) =>
        this.logger.error(
          `[CODIGO] falha ao gerar o codigo do entregador no pedido ${orderId}: ${err?.message}`,
        ),
      );

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
    // Pedido com código não confirma coleta por botão: a prova é a troca de
    // códigos na loja. Deixar o botão aberto seria manter um caminho mais fraco
    // capaz de avançar o mesmo pedido — e o mais fraco é o que acaba sendo
    // usado.
    if (delivery.order?.codigoVendedor) {
      throw new BadRequestException(
        'Este pedido usa confirmação por código. Digite o código da loja na coleta.',
      );
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
  /**
   * @param viaCodigo true somente quando chamado pelo fluxo de códigos.
   *
   * Sem esse parâmetro havia um desvio real: o entregador chamava
   * `confirmDelivery` direto pelo GraphQL, o pedido ia a
   * DELIVERER_CONFIRMED_DELIVERY sem o código do cliente, e dez minutos depois
   * o auto-confirm finalizava e LIBERAVA O REPASSE — exatamente a fraqueza que
   * os códigos existem para fechar. Agora, em pedido com código, só entra por
   * aqui quem veio do registro do código do cliente.
   */
  async confirmDelivery(
    deliveryId: string,
    delivererId: string,
    viaCodigo = false,
  ): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order', 'order.store', 'order.store.owner', 'deliverer'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');
    if (delivery.deliverer?.id !== delivererId) {
      throw new BadRequestException('Esta entrega não pertence a você.');
    }
    if (delivery.order?.codigoVendedor && !viaCodigo) {
      throw new BadRequestException(
        'Este pedido usa confirmação por código. Digite o código do cliente na entrega.',
      );
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
        // payoutAmount guardava a taxa BRUTA, mas o que sai de fato para o
        // entregador e liquido da comissao de entrega (default 10%). Como este
        // campo e @Field e chega no app pelo myDeliveries, o entregador via
        // "R$ 10,00" na tela e "R$ 9,00" no extrato do Pagar.me, toda entrega.
        const comissaoPct =
          await this.platformConfigService.getDeliveryCommissionPercent();
        const brutoCents = Math.round(deliveryFee * 100);
        const liquidoCents =
          brutoCents - Math.round((brutoCents * comissaoPct) / 100);
        delivery.payoutAmount = liquidoCents / 100;
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

  // Perf (F6): paginado (limit/offset); o take de 100 vira teto do limit.
  /** O usuario e parte deste pedido? (cliente, dono da loja ou entregador) */
  async userIsOrderParty(orderId: string, userId: string, role?: string): Promise<boolean> {
    if (!orderId || !userId) return false;
    if (role === 'SUPERADMIN') return true;
    const rows = await this.deliveriesRepository.manager.query(
      `SELECT 1
         FROM orders o
         LEFT JOIN stores s ON s.id = o."storeId"
         LEFT JOIN deliveries d ON d."orderId" = o.id
        WHERE o.id = $1
          AND ($2 IN (o."customerId", s."ownerId") OR d."delivererId" = $2)
        LIMIT 1`,
      [orderId, userId],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  /** O usuario e o entregador atribuido a esta entrega? */
  async delivererOwnsDelivery(deliveryId: string, userId: string): Promise<boolean> {
    if (!deliveryId || !userId) return false;
    const rows = await this.deliveriesRepository.manager.query(
      `SELECT 1 FROM deliveries WHERE id = $1 AND "delivererId" = $2 LIMIT 1`,
      [deliveryId, userId],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async findByDeliverer(delivererId: string, limit = 20, offset = 0): Promise<Delivery[]> {
    const deliveries = await this.deliveriesRepository.find({
      where: { deliverer: { id: delivererId } },
      relations: ['order', 'order.store', 'order.customer', 'order.items', 'order.items.product'],
      order: { createdAt: 'DESC' },
      // Perf (F5): era SEM take — o historico vitalicio do entregador (cada
      // entrega com pedido + itens + produtos aninhados) descia inteiro a cada
      // abertura da aba Entregas. 100 cobre ativas + historico recente; myOrders
      // ja tinha cap analogo (500).
      take: Math.min(Math.max(limit ?? 20, 1), 100),
      skip: Math.max(offset ?? 0, 0),
    });
    return deliveries;
  }

  async findAllAdmin(): Promise<Delivery[]> {
    return this.deliveriesRepository.find({
      relations: ['order', 'order.store', 'order.customer', 'deliverer'],
      order: { createdAt: 'DESC' },
    });
  }

  // KAN-292: versao paginada + filtro (status derivado/busca) do painel admin.
  // O "status" da entrega e derivado de deliveredAt/pickedUpAt (nao ha coluna):
  //   DELIVERED  = deliveredAt IS NOT NULL
  //   DELIVERING = deliveredAt IS NULL AND pickedUpAt IS NOT NULL
  //   PICKED_UP  = deliveredAt IS NULL AND pickedUpAt IS NULL
  async findAllAdminPaginated(
    status: string | null,
    search: string | null,
    limit: number,
    offset: number,
  ): Promise<{ items: Delivery[]; total: number; hasMore: boolean }> {
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const skip = Math.max(Number(offset) || 0, 0);
    const qb = this.deliveriesRepository
      .createQueryBuilder('delivery')
      .leftJoinAndSelect('delivery.order', 'order')
      .leftJoinAndSelect('order.store', 'store')
      .leftJoinAndSelect('order.customer', 'customer')
      .leftJoinAndSelect('delivery.deliverer', 'deliverer')
      .orderBy('delivery.createdAt', 'DESC')
      .addOrderBy('delivery.id', 'DESC');

    if (status === 'DELIVERED') {
      qb.andWhere('delivery.deliveredAt IS NOT NULL');
    } else if (status === 'DELIVERING') {
      qb.andWhere('delivery.deliveredAt IS NULL AND delivery.pickedUpAt IS NOT NULL');
    } else if (status === 'PICKED_UP') {
      qb.andWhere('delivery.deliveredAt IS NULL AND delivery.pickedUpAt IS NULL');
    }
    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      qb.andWhere(
        '(deliverer.name ILIKE :like OR order.orderNumber ILIKE :like OR store.name ILIKE :like OR customer.name ILIKE :like)',
        { like },
      );
    }

    const [items, total] = await qb.skip(skip).take(take).getManyAndCount();
    return { items, total, hasMore: skip + items.length < total };
  }

  // KAN-292: contagens globais para os cards de resumo (independem do filtro).
  async adminCounts(): Promise<{ total: number; active: number; completed: number }> {
    const res = await this.deliveriesRepository
      .createQueryBuilder('delivery')
      .select('COUNT(*)', 'total')
      .addSelect(
        'COUNT(*) FILTER (WHERE delivery."deliveredAt" IS NOT NULL)',
        'completed',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE delivery."deliveredAt" IS NULL)',
        'active',
      )
      .getRawOne();
    return {
      total: Number(res?.total ?? 0),
      active: Number(res?.active ?? 0),
      completed: Number(res?.completed ?? 0),
    };
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
