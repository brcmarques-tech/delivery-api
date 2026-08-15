import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Delivery } from './entities/delivery.entity';
import { DelivererTrackerService } from './deliverer-tracker.service';
import { OrdersService } from '../orders/orders.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatus } from '../common/enums';

@Injectable()
export class GeolocationAutomationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GeolocationAutomationService.name);
  private intervalId: ReturnType<typeof setInterval>;

  // Track previous distances for anomaly detection
  private previousDistances = new Map<string, { distance: number; timestamp: number }[]>();
  // Entregas que ja receberam o aviso de "parado". Sem isso o aviso saia a cada
  // rodada de 30s enquanto o entregador continuasse parado — e o historico
  // permanece cheio de pontos parados, entao a condicao seguia verdadeira. Meia
  // hora no transito ou almocando rendia ~60 pushes identicos, com som e
  // vibracao. Limpa quando ele volta a se mover, para um novo travamento poder
  // avisar de novo.
  private avisadosParado = new Set<string>();

  constructor(
    @InjectRepository(Delivery)
    private deliveriesRepository: Repository<Delivery>,
    private delivererTracker: DelivererTrackerService,
    @Inject(forwardRef(() => OrdersService))
    private ordersService: OrdersService,
    private notificationsService: NotificationsService,
  ) {}

  // Guard de reentrância: o ciclo faz chamadas de rede/settlement; se um ciclo
  // demora mais que 30s, o próximo não deve rodar concorrente e reprocessar as
  // mesmas entregas (notificação/auto-confirm duplicados).
  private isRunning = false;

  onModuleInit() {
    // Check every 30 seconds
    this.intervalId = setInterval(() => {
      this.checkActiveDeliveries();
    }, 30_000);
  }

  onModuleDestroy() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000; // meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // distance in meters
  }

  private async checkActiveDeliveries() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      // Find active deliveries
      const activeDeliveries = await this.deliveriesRepository
        .createQueryBuilder('delivery')
        .leftJoinAndSelect('delivery.order', 'order')
        .leftJoinAndSelect('delivery.deliverer', 'deliverer')
        .leftJoinAndSelect('order.store', 'store')
        .leftJoinAndSelect('order.customer', 'customer')
        .where('order.status IN (:...statuses)', {
          statuses: [
            OrderStatus.VENDOR_CONFIRMED_PICKUP,
            OrderStatus.PICKED_UP,
            OrderStatus.DELIVERING,
            OrderStatus.DELIVERER_CONFIRMED_DELIVERY,
          ],
        })
        .getMany();

      for (const delivery of activeDeliveries) {
        await this.processDelivery(delivery);
      }

      // Purga o mapa previousDistances. Uma entrega concluída/cancelada nunca
      // reaparece na query acima, então a limpeza baseada em status (mais abaixo)
      // era código morto e cada entrega deixava um array de pontos preso na
      // memória para sempre. Remove tudo que não está mais no conjunto ativo.
      const activeIds = new Set(activeDeliveries.map((d) => d.id));
      for (const id of this.previousDistances.keys()) {
        if (!activeIds.has(id)) {
          this.previousDistances.delete(id);
          this.avisadosParado.delete(id);
        }
      }
    } catch (err) {
      this.logger.error('Geolocation check failed:', err);
    } finally {
      this.isRunning = false;
    }
  }

  private async processDelivery(delivery: Delivery) {
    const order = delivery.order;
    const deliverer = delivery.deliverer;
    if (!deliverer) return;

    // Get current deliverer position from tracker
    const location = this.delivererTracker.isOnline(deliverer.id)
      ? this.delivererTracker.getDelivererLocation(deliverer.id)
      : null;

    if (!location) return;

    const now = Date.now();

    // ─── Auto-confirm pickup by proximity ───────────────────────────
    if (order.status === OrderStatus.VENDOR_CONFIRMED_PICKUP && order.vendorConfirmedPickupAt) {
      const store = order.store;
      if (store?.latitude && store?.longitude) {
        const distToStore = this.haversineDistance(
          location.latitude, location.longitude,
          Number(store.latitude), Number(store.longitude),
        );

        // Within 100m of store for 5+ minutes
        const timeSinceVendorConfirmed = now - new Date(order.vendorConfirmedPickupAt).getTime();
        if (distToStore < 100 && timeSinceVendorConfirmed > 5 * 60 * 1000) {
          this.logger.log(`Auto-confirming pickup for order #${order.orderNumber} (proximity: ${Math.round(distToStore)}m)`);
          try {
            // BUGFIX: a transicao valida de VENDOR_CONFIRMED_PICKUP e para
            // DELIVERING — PICKED_UP nao esta na tabela de transicoes, entao o
            // updateStatus lançava SEMPRE (erro engolido pelo catch), a
            // auto-coleta por proximidade nunca avançava o pedido e o pickedUpAt
            // era reescrito e persistido a cada ciclo de 30s. O updateStatus(
            // DELIVERING) ja grava pickedUpAt (orders.service ~1935), entao o
            // save manual saiu.
            await this.ordersService.updateStatus(order.id, OrderStatus.DELIVERING);
          } catch (err) {
            this.logger.error(`Auto-confirm pickup failed for order ${order.id}:`, err);
          }
        }
      }
    }

    // ─── Auto-confirm delivery by proximity ─────────────────────────
    if (order.status === OrderStatus.DELIVERER_CONFIRMED_DELIVERY && order.delivererConfirmedDeliveryAt) {
      if (order.deliveryLatitude && order.deliveryLongitude) {
        const distToCustomer = this.haversineDistance(
          location.latitude, location.longitude,
          Number(order.deliveryLatitude), Number(order.deliveryLongitude),
        );

        const timeSinceDelivererConfirmed = now - new Date(order.delivererConfirmedDeliveryAt).getTime();
        // Within 100m of customer for 10+ minutes
        if (distToCustomer < 100 && timeSinceDelivererConfirmed > 10 * 60 * 1000) {
          this.logger.log(`Auto-confirming delivery for order #${order.orderNumber} (proximity: ${Math.round(distToCustomer)}m)`);
          try {
            // `customerConfirmedAt` era setado so no objeto em memoria, e
            // `completeOrderWithPayment` grava apenas status e completedAt — a
            // coluna nunca era persistida. O pedido ficava COMPLETED e liquidado
            // com customerConfirmedAt NULL, e no modelo de custodia essa e
            // justamente a prova de recebimento que autoriza o repasse: numa
            // disputa ou chargeback a plataforma nao conseguia demonstrar quando
            // e como a entrega foi confirmada, tendo ja repassado a vendedor e
            // entregador. Os outros dois caminhos de confirmacao usam claim
            // atomico e persistem; aqui usamos o mesmo padrao.
            const claim = await this.ordersService.claimCustomerConfirmation(
              order.id,
            );
            if (claim) {
              const fullOrder = await this.ordersService.findById(order.id);
              await this.ordersService.completeOrderWithPayment(fullOrder);
            }
          } catch (err) {
            this.logger.error(`Auto-confirm delivery failed for order ${order.id}:`, err);
          }
        }
      }
    }

    // ─── Anomaly detection during DELIVERING ────────────────────────
    if (order.status === OrderStatus.DELIVERING) {
      const destLat = Number(order.deliveryLatitude);
      const destLng = Number(order.deliveryLongitude);
      if (!destLat || !destLng) return;

      const distToDest = this.haversineDistance(
        location.latitude, location.longitude, destLat, destLng,
      );

      const key = delivery.id;
      if (!this.previousDistances.has(key)) {
        this.previousDistances.set(key, []);
      }
      const history = this.previousDistances.get(key)!;
      history.push({ distance: distToDest, timestamp: now });

      // Keep only last 20 entries (10 minutes at 30s intervals)
      while (history.length > 20) history.shift();

      // Check if deliverer has been stationary for 10+ minutes
      if (history.length >= 20) {
        const oldestDist = history[0].distance;
        const newestDist = history[history.length - 1].distance;
        const timeDiff = now - history[0].timestamp;

        // Not moved more than 50m in 10 minutes
        const parado =
          timeDiff >= 10 * 60 * 1000 && Math.abs(newestDist - oldestDist) < 50;
        if (!parado) {
          this.avisadosParado.delete(key);
        } else if (!this.avisadosParado.has(key)) {
          this.avisadosParado.add(key);
          this.logger.warn(`Deliverer ${deliverer.id} stationary for 10+ min on order #${order.orderNumber}`);
          // Notify deliverer
          this.notificationsService.sendToAppUser(
            deliverer.id,
            `Pedido #${order.orderNumber}`,
            'Voce esta parado ha mais de 10 minutos. Precisa de ajuda?',
            { type: 'DELIVERER_STALLED', orderId: order.id },
          ).catch(() => {});
        }

        // Distance to destination increasing (wrong direction)
        if (timeDiff >= 5 * 60 * 1000 && newestDist > oldestDist + 500) {
          this.logger.warn(`Deliverer ${deliverer.id} going wrong direction on order #${order.orderNumber} (${Math.round(oldestDist)}m → ${Math.round(newestDist)}m)`);
        }
      }
    }

    // Clean up tracking data for completed deliveries
    if ([OrderStatus.COMPLETED, OrderStatus.CANCELLED].includes(order.status as OrderStatus)) {
      this.previousDistances.delete(delivery.id);
      this.avisadosParado.delete(delivery.id);
    }
  }
}
