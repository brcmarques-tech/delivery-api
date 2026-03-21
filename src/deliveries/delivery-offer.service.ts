import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DelivererTrackerService } from './deliverer-tracker.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { AppUsersService } from '../users/app-users.service';

const OFFER_TIMEOUT_MS = 60_000; // 60 seconds per deliverer
const MAX_OFFER_DURATION_MS = 10 * 60_000; // 10 minutes total rotation

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
  declinedBy: Set<string>;
  permanentlyExcluded: Set<string>; // customer ID, etc.
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
      declinedBy: new Set([order.customerId]),
      permanentlyExcluded: new Set([order.customerId]),
      timer: null,
      resolved: false,
      startedAt: Date.now(),
    };

    this.pendingOffers.set(order.id, offer);
    this.logger.log(`Starting offer cascade for order ${order.orderNumber}`);
    this.offerToNext(offer);
  }

  private offerToNext(offer: PendingOffer) {
    if (offer.resolved) return;

    // Check 10-minute total timeout
    const elapsed = Date.now() - offer.startedAt;
    if (elapsed >= MAX_OFFER_DURATION_MS) {
      this.logger.log(`[OFFER] Order ${offer.orderNumber}: 10min timeout reached, alerting vendor`);
      offer.resolved = true;
      this.pendingOffers.delete(offer.orderId);
      // Alert vendor via notification (handled by alertNoDeliverer scheduler)
      // Also broadcast so it stays visible in the list
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

    this.logger.log(`[OFFER] Order ${offer.orderNumber}: found ${nearest.length} available deliverers (excluded: ${offer.declinedBy.size}, elapsed: ${Math.round(elapsed / 1000)}s)`);

    if (nearest.length === 0) {
      // All deliverers tried — reset and loop back to the first
      this.logger.log(`[OFFER] Order ${offer.orderNumber}: all deliverers tried, looping back`);
      offer.declinedBy = new Set(offer.permanentlyExcluded);
      offer.currentDelivererId = null;
      // Small delay before restarting the loop to avoid spamming
      offer.timer = setTimeout(() => {
        this.offerToNext(offer);
      }, 2000);
      return;
    }

    const deliverer = nearest[0];
    offer.currentDelivererId = deliverer.userId;

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

    // Push notification to deliverer
    this.notificationsService.sendToUser(
      deliverer.userId,
      'Nova entrega disponivel!',
      `Pedido #${offer.orderNumber} - R$ ${offer.deliveryFee.toFixed(2)}`,
      { type: 'DELIVERY_OFFER', orderId: offer.orderId },
    ).catch(() => {});

    // WhatsApp notification to deliverer
    this.appUsersService.findById(deliverer.userId).then((user) => {
      if (user?.phone) {
        this.whatsAppService.notifyNewDeliveryAvailable(
          user.phone,
          offer.orderNumber,
          offer.deliveryFee.toFixed(2),
        ).catch(() => {});
      }
    }).catch(() => {});

    // Set timeout — if no response, move to next
    offer.timer = setTimeout(() => {
      if (offer.resolved) return;
      this.logger.log(`Deliverer ${deliverer.userId} timed out for order ${offer.orderNumber}`);
      offer.declinedBy.add(deliverer.userId);
      offer.currentDelivererId = null;
      this.offerToNext(offer);
    }, OFFER_TIMEOUT_MS);
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
   */
  declineOffer(orderId: string, delivererId: string) {
    const offer = this.pendingOffers.get(orderId);
    if (!offer || offer.resolved) return;
    if (offer.currentDelivererId !== delivererId) return;

    if (offer.timer) clearTimeout(offer.timer);
    offer.declinedBy.add(delivererId);
    offer.currentDelivererId = null;
    this.logger.log(`Deliverer ${delivererId} declined order ${offer.orderNumber}`);
    this.offerToNext(offer);
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
      this.pendingOffers.delete(orderId);
    }
  }
}
