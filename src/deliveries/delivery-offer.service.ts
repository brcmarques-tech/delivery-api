import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DelivererTrackerService } from './deliverer-tracker.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { AppUsersService } from '../users/app-users.service';

const OFFER_TIMEOUT_MS = 60_000; // 60 seconds per deliverer
const MAX_OFFER_DURATION_MS = 10 * 60_000; // 10 minutes total rotation

/**
 * A VEZ EXCLUSIVA.
 *
 * Quando o pedido fica pronto, a corrida é oferecida ao entregador online mais
 * perto da loja, e SÓ a ele, por 60s. Ele aceita, recusa, ou o tempo acaba — e
 * a vez passa ao próximo. Depois de 10 minutos sem ninguém, a cascata termina e
 * a corrida abre para todos (para não ficar presa).
 *
 * Antes isso existia só no papel: a cascata escolhia o entregador da vez, mas a
 * lista "Disponíveis" mostrava TODAS as corridas para TODO mundo e o aceite não
 * olhava de quem era a vez. A barra de 60s do app contava do momento em que o
 * card aparecia no celular e não tinha relação nenhuma com a vez. Agora:
 *  - `estadoPara` diz a cada entregador se ele vê a corrida e quanto falta;
 *  - `reservadaParaOutro` é o que o aceite consulta;
 *  - `declineOffer` passa a vez na hora;
 *  - quem já está com uma corrida em andamento é pulado (`filtroDeCandidato`).
 */
interface PendingOffer {
  orderId: string;
  customerId: string;
  storeLat: number;
  storeLng: number;
  storeAddress: string;
  deliveryAddress: string;
  deliveryFee: number;
  itemCount: number;
  orderNumber: string;
  currentDelivererId: string | null;
  // Socket de quem está com a vez: ao terminar a vez, o app dele é avisado e
  // tira a corrida da lista na hora.
  currentSocketId: string | null;
  // Quando a vez atual acaba (ms). Nulo entre uma vez e outra.
  vezExpiraEm: number | null;
  declinedBy: Set<string>;
  permanentlyExcluded: Set<string>; // customer ID, etc.
  // Quem ja recebeu push/WhatsApp DESTA oferta. Como a cascata volta ao inicio
  // quando todos recusam, o mesmo entregador era re-notificado a cada volta.
  jaNotificados: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  resolved: boolean;
  startedAt: number;
}

@Injectable()
export class DeliveryOfferService {
  private readonly logger = new Logger(DeliveryOfferService.name);
  // Map of orderId -> pending offer
  private pendingOffers = new Map<string, PendingOffer>();
  // Callback to emit socket events (set by gateway)
  private emitToSocket: ((socketId: string, event: string, data: any) => void) | null = null;
  private emitToAll: ((event: string, data: any) => void) | null = null;
  // Quem pode receber a vez (definido pelo DeliveriesService: sem corrida em
  // andamento e com conta de recebimento). Sem filtro, todo online pode.
  private filtroDeCandidato: ((userId: string) => Promise<boolean>) | null = null;

  constructor(
    private trackerService: DelivererTrackerService,
    private notificationsService: NotificationsService,
    private whatsAppService: WhatsAppService,
    @Inject(forwardRef(() => AppUsersService))
    private appUsersService: AppUsersService,
  ) {}

  setEmitters(
    emitToSocket: (socketId: string, event: string, data: any) => void,
    emitToAll: (event: string, data: any) => void,
  ) {
    this.emitToSocket = emitToSocket;
    this.emitToAll = emitToAll;
  }

  definirFiltroDeCandidato(filtro: (userId: string) => Promise<boolean>) {
    this.filtroDeCandidato = filtro;
  }

  /**
   * Called when an order becomes READY for delivery.
   * Starts the cascading offer process.
   */
  startOffer(order: {
    id: string;
    customerId: string;
    orderNumber: string;
    storeLat: number;
    storeLng: number;
    storeAddress: string;
    deliveryAddress: string;
    deliveryFee: number;
    itemCount: number;
  }) {
    // Don't double-offer
    if (this.pendingOffers.has(order.id)) return;

    const offer: PendingOffer = {
      orderId: order.id,
      customerId: order.customerId,
      storeLat: order.storeLat,
      storeLng: order.storeLng,
      storeAddress: order.storeAddress,
      deliveryAddress: order.deliveryAddress,
      deliveryFee: order.deliveryFee,
      itemCount: order.itemCount,
      orderNumber: order.orderNumber,
      currentDelivererId: null,
      currentSocketId: null,
      vezExpiraEm: null,
      declinedBy: new Set([order.customerId]),
      jaNotificados: new Set<string>(),
      permanentlyExcluded: new Set([order.customerId]),
      timer: null,
      resolved: false,
      startedAt: Date.now(),
    };

    this.pendingOffers.set(order.id, offer);
    this.logger.log(`Starting offer cascade for order ${order.orderNumber}`);
    this.seguir(offer);
  }

  /** Chama a próxima vez sem deixar erro de rede/banco escapar como rejeição solta. */
  private seguir(offer: PendingOffer) {
    this.offerToNext(offer).catch((err) =>
      this.logger.error(`[OFFER] falha na cascata do pedido ${offer.orderNumber}: ${err?.message}`),
    );
  }

  /** Avisa quem estava com a vez que ela acabou (o app tira a corrida da lista). */
  private encerrarVez(offer: PendingOffer) {
    if (offer.currentSocketId && this.emitToSocket) {
      this.emitToSocket(offer.currentSocketId, 'ofertaEncerrada', { orderId: offer.orderId });
    }
    offer.currentDelivererId = null;
    offer.currentSocketId = null;
    offer.vezExpiraEm = null;
  }

  private async offerToNext(offer: PendingOffer) {
    if (offer.resolved) return;

    // Check 10-minute total timeout
    const elapsed = Date.now() - offer.startedAt;
    if (elapsed >= MAX_OFFER_DURATION_MS) {
      this.logger.log(`[OFFER] Order ${offer.orderNumber}: 10min timeout reached, alerting vendor`);
      offer.resolved = true;
      this.pendingOffers.delete(offer.orderId);
      // Alert vendor via notification (handled by alertNoDeliverer scheduler)
      // A partir daqui a corrida fica ABERTA para todos (estadoPara devolve
      // visível para quem pedir) — o broadcast avisa os apps para recarregar.
      if (this.emitToAll) {
        this.emitToAll('newAvailableDelivery', {
          orderId: offer.orderId,
          orderNumber: offer.orderNumber,
          storeAddress: offer.storeAddress,
          storeLat: offer.storeLat,
          storeLng: offer.storeLng,
          deliveryAddress: offer.deliveryAddress,
          deliveryFee: offer.deliveryFee,
          itemCount: offer.itemCount,
        });
      }
      this.notifyAllDeliverers(offer).catch(() => {});
      return;
    }

    const nearest = this.trackerService.getNearestDeliverers(
      offer.storeLat,
      offer.storeLng,
      offer.declinedBy,
    );

    // Pula quem não pode pegar a corrida agora (já está em outra entrega, sem
    // conta de recebimento). Antes esse entregador recebia a vez exclusiva,
    // não conseguia aceitar, e o pedido perdia 60s parado em cada volta.
    let deliverer: (typeof nearest)[number] | undefined;
    for (const candidato of nearest) {
      const pode = this.filtroDeCandidato ? await this.filtroDeCandidato(candidato.userId) : true;
      if (offer.resolved) return; // aceita/cancelada enquanto esperava o banco
      if (pode) {
        deliverer = candidato;
        break;
      }
      offer.declinedBy.add(candidato.userId);
    }

    this.logger.log(`[OFFER] Order ${offer.orderNumber}: found ${nearest.length} online deliverers (excluded: ${offer.declinedBy.size}, elapsed: ${Math.round(elapsed / 1000)}s)`);

    if (!deliverer) {
      // All deliverers tried — reset and loop back to the first
      this.logger.log(`[OFFER] Order ${offer.orderNumber}: all deliverers tried, looping back`);
      offer.declinedBy = new Set(offer.permanentlyExcluded);
      this.encerrarVez(offer);
      // Small delay before restarting the loop to avoid spamming
      // Era 2s: com UM unico entregador online (cenario normal fora de pico),
      // ele recusava, a lista zerava, e 2s depois a MESMA oferta voltava para
      // ele — ~300 pushes e ~300 mensagens de WhatsApp para o mesmo numero em 10
      // minutos, com risco real de banimento do numero no WhatsApp. 30s mantem a
      // cascata viva sem transformar em spam.
      offer.timer = setTimeout(() => {
        this.seguir(offer);
      }, 30_000);
      return;
    }

    offer.currentDelivererId = deliverer.userId;
    offer.currentSocketId = deliverer.socketId;
    offer.vezExpiraEm = Date.now() + OFFER_TIMEOUT_MS;

    this.logger.log(
      `Offering order ${offer.orderNumber} to deliverer ${deliverer.userId} (${deliverer.distance?.toFixed(1)}km away)`,
    );

    // Send offer to specific deliverer via socket
    if (this.emitToSocket) {
      this.logger.log(`[OFFER] Emitting 'deliveryOffer' to socket ${deliverer.socketId} for order ${offer.orderNumber}`);
      this.emitToSocket(deliverer.socketId, 'deliveryOffer', {
        orderId: offer.orderId,
        orderNumber: offer.orderNumber,
        storeAddress: offer.storeAddress,
        storeLat: offer.storeLat,
        storeLng: offer.storeLng,
        deliveryAddress: offer.deliveryAddress,
        deliveryFee: offer.deliveryFee,
        itemCount: offer.itemCount,
        timeoutSeconds: OFFER_TIMEOUT_MS / 1000,
      });
    } else {
      this.logger.warn(`[OFFER] No emitToSocket set! Cannot send offer for order ${offer.orderNumber}`);
    }

    // Push e WhatsApp so na PRIMEIRA vez que esta oferta chega neste entregador.
    // O evento de socket continua sendo emitido em toda re-oferta (e o canal que
    // desenha o card na tela e nao incomoda), mas push e mensagem nao se repetem.
    const primeiraVez = !offer.jaNotificados.has(deliverer.userId);
    offer.jaNotificados.add(deliverer.userId);

    // Push notification to deliverer
    if (primeiraVez) this.notificationsService.sendToUser(
      deliverer.userId,
      'Nova entrega disponivel!',
      `Pedido #${offer.orderNumber} - R$ ${offer.deliveryFee.toFixed(2)}`,
      { type: 'DELIVERY_OFFER', orderId: offer.orderId },
    ).catch(() => {});

    // WhatsApp notification to deliverer
    if (primeiraVez) this.appUsersService.findById(deliverer.userId).then((user) => {
      if (user?.phone) {
        this.whatsAppService.notifyNewDeliveryAvailable(
          user.phone,
          offer.orderNumber,
          offer.deliveryFee.toFixed(2),
        ).catch(() => {});
      }
    }).catch(() => {});

    // Set timeout — if no response, move to next
    const daVez = deliverer.userId;
    offer.timer = setTimeout(() => {
      if (offer.resolved) return;
      this.logger.log(`Deliverer ${daVez} timed out for order ${offer.orderNumber}`);
      offer.declinedBy.add(daVez);
      this.encerrarVez(offer);
      this.seguir(offer);
    }, OFFER_TIMEOUT_MS);
  }

  /**
   * O que ESTE entregador pode fazer com a corrida agora.
   *  - Corrida fora da cascata (aberta: cascata terminou, ou nunca começou):
   *    visível para todos, sem tempo.
   *  - Na cascata e é a vez dele: visível, com os segundos que restam.
   *  - Na cascata e é a vez de outro (ou entre uma vez e outra): invisível.
   *
   * Os segundos vão prontos do servidor, e não um horário: o relógio do
   * celular pode estar errado (o deste PC nasce +3h a cada boot).
   */
  estadoPara(orderId: string, delivererId: string): { visivel: boolean; segundosRestantes: number | null } {
    const offer = this.pendingOffers.get(orderId);
    if (!offer || offer.resolved) return { visivel: true, segundosRestantes: null };
    if (offer.currentDelivererId === delivererId && offer.vezExpiraEm) {
      return {
        visivel: true,
        segundosRestantes: Math.max(0, Math.ceil((offer.vezExpiraEm - Date.now()) / 1000)),
      };
    }
    return { visivel: false, segundosRestantes: null };
  }

  /** A corrida está na cascata e a vez NÃO é deste entregador? (o aceite consulta) */
  reservadaParaOutro(orderId: string, delivererId: string): boolean {
    return !this.estadoPara(orderId, delivererId).visivel;
  }

  /**
   * Called when a deliverer accepts an offer.
   * Returns true if the offer was still valid.
   */
  acceptOffer(orderId: string, delivererId: string): boolean {
    this.logger.log(`[ACCEPT] acceptOffer called: orderId=${orderId}, delivererId=${delivererId}`);
    const offer = this.pendingOffers.get(orderId);
    if (!offer || offer.resolved) {
      this.logger.log(`[ACCEPT] REJECTED: offer not found or already resolved`);
      return false;
    }
    if (offer.currentDelivererId !== delivererId) {
      this.logger.log(`[ACCEPT] REJECTED: offer is for ${offer.currentDelivererId}, not ${delivererId}`);
      return false;
    }

    offer.resolved = true;
    if (offer.timer) clearTimeout(offer.timer);
    this.pendingOffers.delete(orderId);
    this.logger.log(`[ACCEPT] SUCCESS: Deliverer ${delivererId} accepted order ${offer.orderNumber}`);
    return true;
  }

  /**
   * Called when a deliverer declines an offer.
   * Devolve true se era mesmo a vez dele (e a vez passou adiante).
   */
  declineOffer(orderId: string, delivererId: string): boolean {
    const offer = this.pendingOffers.get(orderId);
    if (!offer || offer.resolved) return false;
    if (offer.currentDelivererId !== delivererId) return false;

    if (offer.timer) clearTimeout(offer.timer);
    offer.declinedBy.add(delivererId);
    this.encerrarVez(offer);
    this.logger.log(`Deliverer ${delivererId} declined order ${offer.orderNumber}`);
    this.seguir(offer);
    return true;
  }

  /**
   * Notify all registered deliverers via push notification (for when no one is online).
   */
  private async notifyAllDeliverers(offer: PendingOffer) {
    const deliverers = await this.appUsersService.findAllDeliverers();
    const toNotify = deliverers.filter(
      (d) => d.expoPushToken && !offer.declinedBy.has(d.id),
    );
    if (toNotify.length === 0) return;

    this.logger.log(`Sending push to ${toNotify.length} offline deliverers for order ${offer.orderNumber}`);
    await this.notificationsService.sendToUsers(
      toNotify.map((d) => d.id),
      'Nova entrega disponivel!',
      `Pedido #${offer.orderNumber} - R$ ${offer.deliveryFee.toFixed(2)}\nDe: ${offer.storeAddress}`,
      { type: 'DELIVERY_OFFER', orderId: offer.orderId },
    );
  }

  /**
   * Cancel an offer (e.g., order cancelled).
   */
  cancelOffer(orderId: string) {
    const offer = this.pendingOffers.get(orderId);
    if (offer) {
      offer.resolved = true;
      if (offer.timer) clearTimeout(offer.timer);
      // Quem estava com a vez (se não foi ele quem aceitou) tira da lista.
      this.encerrarVez(offer);
      this.pendingOffers.delete(orderId);
    }
  }
}
