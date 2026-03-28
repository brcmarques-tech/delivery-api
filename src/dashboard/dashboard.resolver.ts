import { Resolver, Query, ObjectType, Field, Float, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { AppUsersService } from '../users/app-users.service';
import { VendorUsersService } from '../users/vendor-users.service';
import { StoresService } from '../stores/stores.service';
import { OrdersService } from '../orders/orders.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { DelivererTrackerService } from '../deliveries/deliverer-tracker.service';
import { PaymentsService } from '../payments/payments.service';
import { AppointmentsService } from '../appointments/appointments.service';

@ObjectType()
class RoleCount {
  @Field()
  role: string;

  @Field(() => Int)
  count: number;
}

@ObjectType()
class StatusCount {
  @Field()
  status: string;

  @Field(() => Int)
  count: number;
}

@ObjectType()
class DayStats {
  @Field()
  date: string;

  @Field(() => Int)
  count: number;

  @Field(() => Float)
  revenue: number;
}

@ObjectType()
class TopStore {
  @Field()
  storeId: string;

  @Field()
  storeName: string;

  @Field(() => Int)
  orderCount: number;

  @Field(() => Float)
  revenue: number;
}

@ObjectType()
class RecentOrder {
  @Field()
  id: string;

  @Field()
  orderNumber: string;

  @Field()
  status: string;

  @Field(() => Float)
  total: number;

  @Field()
  customerName: string;

  @Field()
  storeName: string;

  @Field()
  createdAt: Date;
}

@ObjectType()
class DashboardStats {
  @Field(() => Int)
  totalUsers: number;

  @Field(() => Int)
  totalStores: number;

  @Field(() => Int)
  totalOrders: number;

  @Field(() => Float)
  totalRevenue: number;

  @Field(() => Float)
  platformRevenue: number;

  @Field(() => [RoleCount])
  usersByRole: RoleCount[];

  @Field(() => [StatusCount])
  ordersByStatus: StatusCount[];

  @Field(() => Int)
  pendingApprovals: number;

  @Field(() => Int)
  totalDeliveries: number;

  @Field(() => Int)
  activeDeliveries: number;

  @Field(() => Int)
  completedDeliveries: number;

  @Field(() => Int)
  onlineDeliverers: number;

  @Field(() => [DayStats])
  ordersByDay: DayStats[];

  @Field(() => [TopStore])
  topStores: TopStore[];

  @Field(() => [RecentOrder])
  recentOrders: RecentOrder[];

  @Field(() => Float)
  avgTicket: number;

  @Field(() => Float)
  cancellationRate: number;

  @Field(() => Int)
  totalAppointments: number;

  @Field(() => Float)
  appointmentRevenue: number;
}

@Resolver()
export class DashboardResolver {
  constructor(
    private appUsersService: AppUsersService,
    private vendorUsersService: VendorUsersService,
    private storesService: StoresService,
    private ordersService: OrdersService,
    private deliveriesService: DeliveriesService,
    private delivererTracker: DelivererTrackerService,
    private paymentsService: PaymentsService,
    private appointmentsService: AppointmentsService,
  ) {}

  @Query(() => DashboardStats)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async dashboardStats(): Promise<DashboardStats> {
    const [
      appUserCount, vendorUserCount, totalStores, totalOrders, orderRevenue, platformRevenue,
      appUsersByRole, ordersByStatus, appPendingCount, vendorPendingCount,
      totalDeliveries, activeDeliveries, completedDeliveries,
      ordersByDay, topStoresRaw, recentOrdersRaw,
      totalAppointments, appointmentRevenue,
    ] = await Promise.all([
      this.appUsersService.totalCount(),
      this.vendorUsersService.totalCount(),
      this.storesService.totalCount(),
      this.ordersService.totalCount(),
      this.ordersService.totalRevenue(),
      this.paymentsService.platformRevenue(),
      this.appUsersService.countByRole(),
      this.ordersService.countByStatus(),
      this.appUsersService.pendingCount(),
      this.vendorUsersService.pendingCount(),
      this.deliveriesService.totalCount(),
      this.deliveriesService.activeCount(),
      this.deliveriesService.completedCount(),
      this.ordersService.ordersByDay(30),
      this.ordersService.topStores(5),
      this.ordersService.recentOrders(5),
      this.appointmentsService.analyticsTotalCount(),
      this.appointmentsService.analyticsTotalRevenue(),
    ]);

    const usersByRole = [
      ...appUsersByRole.map((r) => ({ role: r.role, count: Number(r.count) })),
      { role: 'VENDOR', count: Number(vendorUserCount) },
    ];

    const mappedStatus = ordersByStatus.map((s) => ({ status: s.status, count: Number(s.count) }));
    const deliveredCount = mappedStatus
      .filter((s) => ['DELIVERED', 'COMPLETED'].includes(s.status))
      .reduce((sum, s) => sum + s.count, 0);
    const cancelledCount = mappedStatus
      .filter((s) => ['CANCELLED', 'REJECTED', 'EXPIRED'].includes(s.status))
      .reduce((sum, s) => sum + s.count, 0);

    const totalRevenue = orderRevenue + appointmentRevenue;

    return {
      totalUsers: appUserCount + vendorUserCount,
      totalStores,
      totalOrders,
      totalRevenue,
      platformRevenue,
      usersByRole,
      ordersByStatus: mappedStatus,
      pendingApprovals: appPendingCount + vendorPendingCount,
      totalDeliveries,
      activeDeliveries,
      completedDeliveries,
      onlineDeliverers: this.delivererTracker.getOnlineCount(),
      ordersByDay,
      topStores: topStoresRaw,
      recentOrders: recentOrdersRaw.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        total: Number(o.total),
        customerName: o.customer?.name || 'Desconhecido',
        storeName: o.store?.name || 'Desconhecida',
        createdAt: o.createdAt,
      })),
      avgTicket: deliveredCount > 0 ? orderRevenue / deliveredCount : 0,
      cancellationRate: totalOrders > 0 ? (cancelledCount / totalOrders) * 100 : 0,
      totalAppointments,
      appointmentRevenue,
    };
  }
}
