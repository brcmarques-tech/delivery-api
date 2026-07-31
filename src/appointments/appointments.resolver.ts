import { Resolver, Query, Mutation, Args, Float, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { Appointment } from './entities/appointment.entity';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentInput } from './dto/create-appointment.input';
import { RequestQuoteInput } from './dto/request-quote.input';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

@Resolver(() => Appointment)
export class AppointmentsResolver {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  // ─── Public Queries ─────────────────────────────────────

  @Query(() => [String])
  availableSlots(
    @Args('storeId') storeId: string,
    @Args('serviceId') serviceId: string,
    @Args('date') date: string,
  ): Promise<string[]> {
    return this.appointmentsService.availableSlots(storeId, serviceId, date);
  }

  // ─── Customer Queries ───────────────────────────────────

  @Query(() => [Appointment])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  myAppointments(
    @CurrentUser() user: any,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<Appointment[]> {
    // Perf (F6): paginado.
    return this.appointmentsService.myAppointments(user.id, limit, offset);
  }

  @Query(() => Appointment)
  @UseGuards(GqlAuthGuard)
  appointment(
    @Args('id') id: string,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    // KAN-225: escopa por dono (cliente ou dono da loja)
    return this.appointmentsService.findByIdForUser(id, user.id);
  }

  // ─── Vendor Queries ─────────────────────────────────────

  @Query(() => [Appointment])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  storeAppointments(
    @Args('storeId') storeId: string,
    @Args('date', { nullable: true }) date: string,
    @Args('status', { type: () => AppointmentStatus, nullable: true }) status: AppointmentStatus,
    @CurrentUser() user: any,
  ): Promise<Appointment[]> {
    return this.appointmentsService.storeAppointments(storeId, user.id, date, status);
  }

  // ─── Customer Mutations ─────────────────────────────────

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  createAppointment(
    @Args('input') input: CreateAppointmentInput,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.create(input, user);
  }

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  requestQuote(
    @Args('input') input: RequestQuoteInput,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.requestQuote(input, user);
  }

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  cancelAppointment(
    @Args('id') id: string,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.cancelAppointment(id, user.id);
  }

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  acceptQuote(
    @Args('id') id: string,
    @Args('scheduledDate') scheduledDate: string,
    @Args('scheduledTime') scheduledTime: string,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.acceptQuote(id, scheduledDate, scheduledTime, user.id);
  }

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  rejectQuote(
    @Args('id') id: string,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.rejectQuote(id, user.id);
  }

  // ─── Vendor Mutations ───────────────────────────────────

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  confirmAppointment(
    @Args('id') id: string,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.confirmAppointment(id, user.id);
  }

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  vendorCancelAppointment(
    @Args('id') id: string,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.vendorCancelAppointment(id, user.id);
  }

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  completeAppointment(
    @Args('id') id: string,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.completeAppointment(id, user.id);
  }

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  markNoShow(
    @Args('id') id: string,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.markNoShow(id, user.id);
  }

  @Mutation(() => Appointment)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  respondQuote(
    @Args('id') id: string,
    @Args('price', { type: () => Float }) price: number,
    @Args('response') response: string,
    @CurrentUser() user: any,
  ): Promise<Appointment> {
    return this.appointmentsService.respondQuote(id, price, response, user.id);
  }
}
