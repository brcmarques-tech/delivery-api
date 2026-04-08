import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  HttpCode,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { StoresService } from '../stores/stores.service';
import { OrdersService } from '../orders/orders.service';
import { AppUser } from '../users/entities/app-user.entity';
import { OrderStatus } from '../common/enums';

@Controller('n8n')
export class N8nAgentController {
  constructor(
    private readonly storesService: StoresService,
    private readonly ordersService: OrdersService,
    private readonly configService: ConfigService,
    @InjectRepository(AppUser)
    private readonly appUsersRepository: Repository<AppUser>,
  ) {}

  private checkAuth(key: string) {
    const expected = this.configService.get<string>('N8N_AGENT_KEY');
    if (expected && key !== expected) throw new UnauthorizedException();
  }

  @Get('stores/by-phone')
  async storeByPhone(
    @Query('phone') phone: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const digits = phone?.replace(/\D/g, '') ?? '';
    const store = await this.storesService.findByWhatsappNumber(digits);
    if (!store) return null;
    return {
      id: store.id,
      name: store.name,
      city: store.city,
      state: store.state,
    };
  }

  @Get('users/by-phone')
  async userByPhone(
    @Query('phone') phone: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const digits = phone?.replace(/\D/g, '') ?? '';
    const user = await this.appUsersRepository
      .createQueryBuilder('u')
      .where(
        "REPLACE(REPLACE(REPLACE(u.phone, '+', ''), '-', ''), ' ', '') LIKE :suffix",
        {
          suffix: `%${digits.slice(-8)}`,
        },
      )
      .getOne();
    if (!user) return null;
    return { id: user.id, name: user.name, phone: user.phone };
  }

  @Get('orders/pending')
  async pendingOrders(
    @Query('storeId') storeId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const orders = await this.ordersService.findByStore(storeId);
    const pending = orders.filter((o) =>
      [
        OrderStatus.PENDING,
        OrderStatus.AWAITING_PAYMENT,
        OrderStatus.PAYMENT_REVIEW,
      ].includes(o.status),
    );
    return {
      count: pending.length,
      orders: pending.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        customer: o.customer?.name,
        total: o.total,
        items: o.items
          ?.map((i) => `${i.quantity}x ${i.product?.name}`)
          .join(', '),
      })),
    };
  }

  @Get('orders/summary')
  async dailySummary(
    @Query('storeId') storeId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const orders = await this.ordersService.findByStore(storeId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayOrders = orders.filter((o) => new Date(o.createdAt) >= today);
    const delivered = todayOrders.filter(
      (o) => o.status === OrderStatus.DELIVERED,
    );
    const inProgress = todayOrders.filter((o) =>
      [
        OrderStatus.PENDING,
        OrderStatus.ACCEPTED,
        OrderStatus.PREPARING,
        OrderStatus.READY,
        OrderStatus.DELIVERING,
      ].includes(o.status),
    );
    const revenue = delivered.reduce((sum, o) => sum + Number(o.total), 0);
    return {
      todayOrders: todayOrders.length,
      delivered: delivered.length,
      inProgress: inProgress.length,
      revenue: `R$${revenue.toFixed(2)}`,
    };
  }

  @Get('orders/customer')
  async ordersByCustomer(
    @Query('customerId') customerId: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const orders = await this.ordersService.findByCustomer(customerId);
    return {
      count: orders.length,
      orders: orders.slice(0, 5).map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        store: o.store?.name,
        total: o.total,
        createdAt: o.createdAt,
      })),
    };
  }

  @Get('orders/number/:orderNumber')
  async orderByNumber(
    @Param('orderNumber') orderNumber: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const order = await this.ordersService.findByOrderNumber(orderNumber);
    if (!order) throw new NotFoundException('Pedido nao encontrado');
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      store: order.store?.name,
      storeId: order.store?.id,
      customerId: order.customer?.id,
      total: order.total,
      items: order.items
        ?.map((i) => `${i.quantity}x ${i.product?.name}`)
        .join(', '),
      createdAt: order.createdAt,
    };
  }

  @Get('orders')
  async ordersByStore(
    @Query('storeId') storeId: string,
    @Query('status') status: string,
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const orders = await this.ordersService.findByStore(storeId);
    const filtered = status
      ? orders.filter((o) => o.status === status)
      : orders.slice(0, 10);
    return {
      count: filtered.length,
      orders: filtered.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        customer: o.customer?.name,
        total: o.total,
      })),
    };
  }

  @Post('orders/status')
  @HttpCode(200)
  async updateOrderStatus(
    @Body()
    body: {
      orderNumber: string;
      status: string;
      actorEmail?: string;
      storeId?: string;
    },
    @Headers('x-n8n-key') key: string,
  ) {
    this.checkAuth(key);
    const order = await this.ordersService.findByOrderNumber(body.orderNumber);
    if (!order) throw new NotFoundException('Pedido nao encontrado');

    // If storeId provided, verify ownership
    if (body.storeId && order.store?.id !== body.storeId) {
      throw new ForbiddenException('Pedido nao pertence a esta loja');
    }

    const actorEmail =
      body.actorEmail ??
      this.configService.get('AGENT_APP_USER_EMAIL', 'agente@bcmtech.com.br');
    const actor = await this.appUsersRepository.findOne({
      where: { email: actorEmail },
    });
    if (!actor) throw new NotFoundException('Usuario agente nao encontrado');

    const updated = await this.ordersService.updateStatus(
      order.id,
      body.status as OrderStatus,
      actor,
    );
    return {
      success: true,
      orderNumber: updated.orderNumber,
      newStatus: updated.status,
    };
  }
}
