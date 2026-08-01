import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { verify as jwtVerify } from 'jsonwebtoken';
import { DeliveriesService } from './deliveries.service';
import { DelivererTrackerService } from './deliverer-tracker.service';
import { DeliveryOfferService } from './delivery-offer.service';
import { AppUsersService } from '../users/app-users.service';
import { Inject, forwardRef } from '@nestjs/common';

// SEGURANCA (critico): este gateway Socket.IO nao tinha NENHUMA autenticacao —
// nem no handshake, nem por guard — e confiava no `userId`/`deliveryId` que
// vinham no CORPO da mensagem. O handshake do GraphQL-WS ja fora endurecido
// (KAN-253), mas este e um servidor Socket.IO separado no mesmo processo e
// ficou de fora. Consequencias reais, todas anonimas:
//   - `delivererOnline` com o userId de outro entregador injetava GPS falso no
//     tracker; a automacao por geolocalizacao le exatamente esse mapa e, com o
//     ponto forjado perto do cliente por 10 min, chama completeOrderWithPayment
//     — LIBERANDO O REPASSE de um pedido que nunca foi entregue.
//   - `updateLocation` gravava coordenadas em QUALQUER entrega.
//   - `joinOrder` entrava na sala de qualquer pedido (GPS + status alheios).
//   - `acceptOffer`/`declineOffer` roubavam ou matavam a oferta pendente.
// Agora: JWT obrigatorio no handshake e identidade derivada da sessao, nunca do
// payload. CORS tambem sai do '*' e usa a mesma allowlist do main.ts.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

@WebSocketGateway({
  cors: { origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : '*', credentials: true },
})
export class DeliveriesGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
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

  /** Identidade autenticada do socket (nunca vinda do payload). */
  private userIdOf(client: Socket): string | null {
    return (client.data as any)?.user?.sub ?? null;
  }

  handleConnection(client: Socket) {
    const raw =
      (client.handshake.auth as any)?.token ||
      (client.handshake.headers?.authorization as string) ||
      '';
    const token = String(raw).replace(/^Bearer\s+/i, '').trim();
    const secret = process.env.JWT_SECRET;
    if (!token || !secret) {
      client.disconnect(true);
      return;
    }
    try {
      (client.data as any).user = jwtVerify(token, secret);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const userId = this.trackerService.removeBySocketId(client.id);
    if (userId) {
      this.lastLocationUpdate.delete(userId);
      this.lastOnlineEvent.delete(userId);
    }
  }

  @SubscribeMessage('joinOrder')
  async handleJoinOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: string | { orderId: string },
  ) {
    const uid = this.userIdOf(client);
    if (!uid) return;
    const orderId = typeof data === 'string' ? data : data.orderId;
    // So entra na sala quem e parte do pedido (mesma regra do filtro das
    // subscriptions GraphQL). Antes qualquer um acompanhava qualquer pedido.
    const role = (client.data as any)?.user?.role;
    const ehParte = await this.deliveriesService.userIsOrderParty(orderId, uid, role);
    if (!ehParte) return;
    client.join(`order:${orderId}`);
  }

  @SubscribeMessage('updateLocation')
  async handleUpdateLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { deliveryId: string; latitude: number; longitude: number },
  ) {
    const uid = this.userIdOf(client);
    if (!uid) return;
    // So o entregador DAQUELA entrega pode mover o ponto dela.
    const dono = await this.deliveriesService.delivererOwnsDelivery(data.deliveryId, uid);
    if (!dono) return;
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
    @MessageBody() data: { userId?: string; latitude: number; longitude: number },
  ) {
    // Identidade da SESSAO — antes vinha do payload, permitindo se passar por
    // qualquer entregador e injetar GPS falso no tracker.
    const uid = this.userIdOf(client);
    if (!uid) return { status: 'unauthorized' };
    data = { ...data, userId: uid };
    const now = Date.now();
    const last = this.lastOnlineEvent.get(uid) || 0;
    if (now - last < DeliveriesGateway.ONLINE_THROTTLE_MS && this.trackerService.isOnline(uid)) {
      // Already online and recently processed — just update socket and return
      client.join('deliverers');
      return { status: 'online', onlineCount: this.trackerService.getOnlineCount() };
    }
    this.lastOnlineEvent.set(uid, now);

    let vehicleType = 'MOTO';
    try {
      const user = await this.appUsersService.findById(uid);
      if (user?.vehicleType) vehicleType = user.vehicleType;
    } catch {}
    this.trackerService.setOnline(uid, client.id, data.latitude, data.longitude, vehicleType);
    client.join('deliverers');
    return { status: 'online', onlineCount: this.trackerService.getOnlineCount() };
  }

  @SubscribeMessage('delivererLocationUpdate')
  handleDelivererLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId?: string; latitude: number; longitude: number },
  ) {
    const uid = this.userIdOf(client);
    if (!uid) return;
    const now = Date.now();
    const last = this.lastLocationUpdate.get(uid) || 0;
    if (now - last < DeliveriesGateway.LOCATION_THROTTLE_MS) {
      return; // Throttled — skip this update
    }
    this.lastLocationUpdate.set(uid, now);
    this.trackerService.updateLocation(uid, data.latitude, data.longitude);
  }

  @SubscribeMessage('delivererOffline')
  handleDelivererOffline(
    @ConnectedSocket() client: Socket,
    @MessageBody() _data: { userId?: string },
  ) {
    // Identidade da sessao — antes dava para derrubar qualquer entregador.
    const uid = this.userIdOf(client);
    if (!uid) return { status: 'unauthorized' };
    this.trackerService.setOffline(uid);
    this.lastLocationUpdate.delete(uid);
    this.lastOnlineEvent.delete(uid);
    client.leave('deliverers');
    return { status: 'offline' };
  }

  @SubscribeMessage('acceptOffer')
  handleAcceptOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string; delivererId?: string },
  ) {
    // Identidade da sessao — antes qualquer cliente aceitava a oferta em nome de
    // outro, encerrando a cascata (o pedido ficava sem entregador nenhum).
    const uid = this.userIdOf(client);
    if (!uid) return { accepted: false };
    const accepted = this.offerService.acceptOffer(data.orderId, uid);
    return { accepted };
  }

  @SubscribeMessage('declineOffer')
  handleDeclineOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string; delivererId?: string },
  ) {
    const uid = this.userIdOf(client);
    if (!uid) return { status: 'unauthorized' };
    this.offerService.declineOffer(data.orderId, uid);
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
