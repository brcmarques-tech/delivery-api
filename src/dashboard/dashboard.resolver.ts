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
  ) {}

  @Query(() => DashboardStats)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async dashboardStats(): Promise<DashboardStats> {
    const [
      appUserCount, vendorUserCount, totalStores, totalOrders, totalRevenue, platformRevenue,
      appUsersByRole, ordersByStatus, appPendingCount, vendorPendingCount,
      totalDeliveries, activeDeliveries, completedDeliveries,
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
    ]);

    const usersByRole = [
      ...appUsersByRole.map((r) => ({ role: r.role, count: Number(r.count) })),
      { role: 'VENDOR', count: Number(vendorUserCount) },
    ];

    return {
      totalUsers: appUserCount + vendorUserCount,
      totalStores,
      totalOrders,
      totalRevenue,
      platformRevenue,
      usersByRole,
      ordersByStatus: ordersByStatus.map((s) => ({ status: s.status, count: Number(s.count) })),
      pendingApprovals: appPendingCount + vendorPendingCount,
      totalDeliveries,
      activeDeliveries,
      completedDeliveries,
      onlineDeliverers: this.delivererTracker.getOnlineCount(),
    };
  }
}
