import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { comTravaDistribuida } from '../common/utils/trava-distribuida';

@Injectable()
export class AppointmentReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppointmentReminderScheduler.name);
  private intervalId: ReturnType<typeof setInterval>;
  private isRunning = false;

  constructor(
    private appointmentsService: AppointmentsService,
    @InjectDataSource() private dataSource: DataSource,
  ) {}

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
      // KAN-254: com duas instancias, as duas mandam o MESMO lembrete para o
      // mesmo cliente no mesmo minuto. A trava e do banco, entao vale para a
      // frota inteira.
      await comTravaDistribuida(this.dataSource, 'tick:lembretes-de-agendamento', async () => {
        await this.sendReminders();
        await this.expireUnpaid();
        await this.retryLiquidacoes();
      });
    } finally {
      this.isRunning = false;
    }
  }

  onModuleDestroy() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  /**
   * Re-tenta a liquidação de AGENDAMENTOS que falhou.
   *
   * O ciclo de pedido já tinha retry (retryFailedSettlements); o de agendamento
   * não tinha nenhum. Quando a liquidação falhava — provedor fora do ar,
   * recebedor sem conta, pré-autorização expirada — o dinheiro simplesmente
   * ficava parado na plataforma, sem ninguém re-tentar e sem alarme: o
   * agendamento aparecia como concluído e o prestador nunca recebia.
   *
   * O `try/catch` aqui é obrigatório, não zelo: este método roda dentro do tick
   * do scheduler, e uma exceção escapando daqui mataria os outros jobs da
   * rodada.
   */
  private async retryLiquidacoes() {
    try {
      const n = await this.appointmentsService.retryFailedAppointmentSettlements();
      if (n > 0) {
        this.logger.log(`Liquidacao de ${n} agendamento(s) re-tentada com sucesso`);
      }
    } catch (err) {
      this.logger.error('Falha ao re-tentar liquidacao de agendamentos:', err);
    }
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
