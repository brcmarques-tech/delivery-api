import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DeliveriesService } from './deliveries.service';
import { DelivererTrackerService } from './deliverer-tracker.service';
import { DeliveryOfferService } from './delivery-offer.service';
import { AppUsersService } from '../users/app-users.service';
import { Inject, forwardRef } from '@nestjs/common';

@WebSocketGateway({ cors: { origin: '*' } })
export class DeliveriesGateway implements OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server: Server;

  // Throttle: last processed timestamp per deliverer
  private lastLocationUpdate = new Map<string, number>();
  private lastOnlineEvent = new Map<string, number>();
  private static readonly LOCATION_THROTTLE_MS = 10_000; // 10s
  private static readonly ONLINE_THROTTLE_MS = 30_000;   // 30s

  constructor(
    private deliveriesService: DeliveriesService,
    private trackerService: DelivererTrackerService,
    private offerService: DeliveryOfferService,
    @Inject(forwardRef(() => AppUsersService))
    private appUsersService: AppUsersService,
  ) {}

  afterInit() {
    this.offerService.setEmitters(
      (socketId, event, data) => this.server.to(socketId).emit(event, data),
      (event, data) => this.server.emit(event, data),
    );
  }

  handleDisconnect(client: Socket) {
    const userId = this.trackerService.removeBySocketId(client.id);
    if (userId) {
      this.lastLocationUpdate.delete(userId);
      this.lastOnlineEvent.delete(userId);
    }
  }

  @SubscribeMessage('joinOrder')
  handleJoinOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: string | { orderId: string },
  ) {
    const orderId = typeof data === 'string' ? data : data.orderId;
    client.join(`order:${orderId}`);
  }

  @SubscribeMessage('updateLocation')
  async handleUpdateLocation(
    @MessageBody() data: { deliveryId: string; latitude: number; longitude: number },
  ) {
    const delivery = await this.deliveriesService.updateLocation(
      data.deliveryId,
      data.latitude,
      data.longitude,
    );

    this.server.to(`order:${delivery.order.id}`).emit('locationUpdate', {
      deliveryId: delivery.id,
      latitude: data.latitude,
      longitude: data.longitude,
    });
  }

  @SubscribeMessage('delivererOnline')
  async handleDelivererOnline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId: string; latitude: number; longitude: number },
  ) {
    const now = Date.now();
    const last = this.lastOnlineEvent.get(data.userId) || 0;
    if (now - last < DeliveriesGateway.ONLINE_THROTTLE_MS && this.trackerService.isOnline(data.userId)) {
      // Already online and recently processed — just update socket and return
      client.join('deliverers');
      return { status: 'online', onlineCount: this.trackerService.getOnlineCount() };
    }
    this.lastOnlineEvent.set(data.userId, now);

    let vehicleType = 'MOTO';
    try {
      const user = await this.appUsersService.findById(data.userId);
      if (user?.vehicleType) vehicleType = user.vehicleType;
    } catch {}
    this.trackerService.setOnline(data.userId, client.id, data.latitude, data.longitude, vehicleType);
    client.join('deliverers');
    return { status: 'online', onlineCount: this.trackerService.getOnlineCount() };
  }

  @SubscribeMessage('delivererLocationUpdate')
  handleDelivererLocationUpdate(
    @MessageBody() data: { userId: string; latitude: number; longitude: number },
  ) {
    const now = Date.now();
    const last = this.lastLocationUpdate.get(data.userId) || 0;
    if (now - last < DeliveriesGateway.LOCATION_THROTTLE_MS) {
      return; // Throttled — skip this update
    }
    this.lastLocationUpdate.set(data.userId, now);
    this.trackerService.updateLocation(data.userId, data.latitude, data.longitude);
  }

  @SubscribeMessage('delivererOffline')
  handleDelivererOffline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId: string },
  ) {
    this.trackerService.setOffline(data.userId);
    this.lastLocationUpdate.delete(data.userId);
    this.lastOnlineEvent.delete(data.userId);
    client.leave('deliverers');
    return { status: 'offline' };
  }

  @SubscribeMessage('acceptOffer')
  handleAcceptOffer(
    @MessageBody() data: { orderId: string; delivererId: string },
  ) {
    const accepted = this.offerService.acceptOffer(data.orderId, data.delivererId);
    return { accepted };
  }

  @SubscribeMessage('declineOffer')
  handleDeclineOffer(
    @MessageBody() data: { orderId: string; delivererId: string },
  ) {
    this.offerService.declineOffer(data.orderId, data.delivererId);
    return { status: 'declined' };
  }

  emitOrderStatusUpdate(orderId: string, status: string) {
    this.server.to(`order:${orderId}`).emit('orderStatusUpdate', { orderId, status });
  }

  emitDeliveryConfirmationRequired(orderId: string, deliveredAt: string) {
    this.server.to(`order:${orderId}`).emit('deliveryConfirmationRequired', {
      orderId,
      deliveredAt,
      expiresAt: new Date(new Date(deliveredAt).getTime() + 10 * 60 * 1000).toISOString(),
    });
  }
}
