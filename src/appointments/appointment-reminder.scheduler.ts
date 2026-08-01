import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { AppointmentsService } from './appointments.service';

@Injectable()
export class AppointmentReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppointmentReminderScheduler.name);
  private intervalId: ReturnType<typeof setInterval>;

  constructor(private appointmentsService: AppointmentsService) {}

  onModuleInit() {
    // Check every 5 minutes
    this.intervalId = setInterval(() => {
      this.sendReminders();
      this.expireUnpaid();
    }, 5 * 60_000);
  }

  onModuleDestroy() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private async expireUnpaid() {
    try {
      const count = await this.appointmentsService.expireUnpaidAppointments();
      if (count > 0) {
        this.logger.log(`Cancelados ${count} agendamentos sem pagamento (horarios liberados)`);
      }
    } catch (err) {
      this.logger.error('Falha ao expirar agendamentos sem pagamento:', err);
    }
  }

  private async sendReminders() {
    try {
      const count = await this.appointmentsService.sendUpcomingReminders();
      if (count > 0) {
        this.logger.log(`Sent ${count} appointment reminders`);
      }
    } catch (err) {
      this.logger.error('Failed to send appointment reminders:', err);
    }
  }
}
