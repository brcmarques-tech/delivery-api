import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DeliveriesService } from './deliveries.service';

@WebSocketGateway({ cors: { origin: '*' } })
export class DeliveriesGateway {
  @WebSocketServer()
  server: Server;

  constructor(private deliveriesService: DeliveriesService) {}

  @SubscribeMessage('joinOrder')
  handleJoinOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() orderId: string,
  ) {
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

  emitOrderStatusUpdate(orderId: string, status: string) {
    this.server.to(`order:${orderId}`).emit('orderStatusUpdate', { orderId, status });
  }
}
