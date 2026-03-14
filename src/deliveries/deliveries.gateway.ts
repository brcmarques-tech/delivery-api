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
    this.trackerService.removeBySocketId(client.id);
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
    this.trackerService.updateLocation(data.userId, data.latitude, data.longitude);
  }

  @SubscribeMessage('delivererOffline')
  handleDelivererOffline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId: string },
  ) {
    this.trackerService.setOffline(data.userId);
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
