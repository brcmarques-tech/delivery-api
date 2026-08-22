import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { AppointmentsService } from './appointments.service';

@Injectable()
export class AppointmentReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppointmentReminderScheduler.name);
  private intervalId: ReturnType<typeof setInterval>;
  private isRunning = false;

  constructor(private appointmentsService: AppointmentsService) {}

  onModuleInit() {
    // Check every 5 minutes
    this.intervalId = setInterval(() => {
      void this.tick();
    }, 5 * 60_000);
  }

  // Guarda de reentrancia + await (mesmo padrao de delivery-confirmation e
  // geolocation-automation): as tarefas fazem save() sequencial por item; se uma
  // rodada passar de 5 min, a proxima nao pode rodar concorrente sobre as mesmas
  // linhas. Antes as duas eram fire-and-forget sem essa protecao.
  private async tick() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.sendReminders();
      await this.expireUnpaid();
    } finally {
      this.isRunning = false;
    }
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
