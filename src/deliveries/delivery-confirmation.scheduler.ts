import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { OrdersService } from '../orders/orders.service';
import { DeliveryCodesService } from '../orders/delivery-codes.service';
import { PaymentsService } from '../payments/payments.service';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { comTravaDistribuida } from '../common/utils/trava-distribuida';

@Injectable()
export class DeliveryConfirmationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryConfirmationScheduler.name);
  private intervalId: ReturnType<typeof setInterval>;
  // R#3: guarda de reentrância. ANTES os 6 jobs disparavam fire-and-forget a cada
  // 60s; como cada um faz várias chamadas ao Pagar.me e pode passar de 60s, a
  // rodada seguinte começava sobre as MESMAS linhas ainda sendo mutadas —
  // amplificando o estorno duplo do refundOrder (R#1) e o restore de estoque em
  // dobro, sem nenhuma ação do usuário. Agora uma rodada só começa se a anterior
  // terminou, e os jobs rodam em sequência (cada um já tem seu try/catch).
  private isRunning = false;

  constructor(
    private ordersService: OrdersService,
    private deliveryCodesService: DeliveryCodesService,
    private paymentsService: PaymentsService,
    @InjectDataSource() private dataSource: DataSource,
  ) {}

  onModuleInit() {
    // Check every 60 seconds
    this.intervalId = setInterval(() => {
      this.tick().catch((err) => this.logger.error('Tick do scheduler falhou:', err));
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private async tick() {
    if (this.isRunning) {
      this.logger.warn('Rodada anterior ainda em execução — pulando esta.');
      return;
    }
    this.isRunning = true;
    try {
      // KAN-254: a guarda `isRunning` protege contra a rodada anterior DESTE
      // processo. Com duas instancias da API, as duas acordam no mesmo minuto
      // e rodam a mesma rotina sobre as mesmas linhas — trabalho duplicado e,
      // o que o cliente ve, notificacao duplicada. A trava e do banco (advisory
      // lock), entao vale para a frota inteira. Quem nao pegar, pula o tick.
      await comTravaDistribuida(this.dataSource, 'tick:confirmacao-de-entrega', async () => {
        await this.expireAwaitingPaymentOrders();
        await this.expirePendingOrders();
        await this.autoAdvanceVendorConfirmedPickup();
        await this.autoConfirmExpiredDeliveries();
        await this.alertNoDeliverer();
        await this.liberarEntregasSemCodigoVencidas();
        await this.retryFailedSettlements();
        await this.drenarPassivos();
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Paga automaticamente o que esta registrado como devido (passivos).
   *
   * Hoje nao vai conseguir: a rota de transferencia do Pagar.me esta atras da
   * allowlist de IP da conta (KAN-299). Fica no tick de proposito — no minuto
   * em que o IP for liberado, a divida acumulada zera sozinha na primeira
   * rodada, em vez de alguem descobrir semanas de passivo para conciliar a
   * mao na tela de repasses.
   *
   * O `bloqueado: true` so vira log em nivel WARN, e uma vez por rodada: o
   * detalhe de POR QUE esta bloqueado ja esta no proprio metodo, e repetir
   * aqui so encheria o log.
   */
  private async drenarPassivos() {
    try {
      const r = await this.paymentsService.drenarPassivos();
      if (r.pagos > 0) {
        this.logger.log(`Drenagem de passivos: ${r.pagos} repasse(s) pago(s)`);
      }
    } catch (err) {
      this.logger.error('Falha na drenagem de passivos:', err);
    }
  }

  // Liberar entregas registradas SEM o código do cliente, cuja janela de
  // contestação venceu sem o cliente contestar.
  //
  // Este job é o que substitui o auto-confirm por decurso de prazo que existia
  // antes: ali o pagamento saía sem prova nenhuma e sem o cliente ter sido
  // avisado; aqui ele só sai depois de um registro com foto, GPS e horário, e
  // depois de o cliente ter tido a janela inteira para contestar.
  private async liberarEntregasSemCodigoVencidas() {
    try {
      const count =
        await this.deliveryCodesService.liberarEntregasSemCodigoVencidas();
      if (count > 0) {
        this.logger.log(
          `Liberadas ${count} entrega(s) sem código após a janela de contestação`,
        );
      }
    } catch (err) {
      this.logger.error('Falha ao liberar entregas sem código:', err);
    }
  }

  // Expirar pedidos sem pagamento (AWAITING_PAYMENT > 30 min)
  private async expireAwaitingPaymentOrders() {
    try {
      const count = await this.ordersService.expireAwaitingPaymentOrders();
      if (count > 0) {
        this.logger.log(`Expired ${count} awaiting payment orders`);
      }
    } catch (err) {
      this.logger.error('Failed to expire awaiting payment orders:', err);
    }
  }

  // Expirar pedidos PENDING sem resposta do vendedor (> 10 min)
  private async expirePendingOrders() {
    try {
      const count = await this.ordersService.expirePendingOrders();
      if (count > 0) {
        this.logger.log(`Expired ${count} pending orders (vendor no response)`);
      }
    } catch (err) {
      this.logger.error('Failed to expire pending orders:', err);
    }
  }

  // Auto-avançar VENDOR_CONFIRMED_PICKUP se entregador não confirmar em 5 min
  private async autoAdvanceVendorConfirmedPickup() {
    try {
      const count = await this.ordersService.autoAdvanceVendorConfirmedPickup();
      if (count > 0) {
        this.logger.log(`Auto-advanced ${count} orders from VENDOR_CONFIRMED_PICKUP to DELIVERING`);
      }
    } catch (err) {
      this.logger.error('Failed to auto-advance vendor confirmed pickup:', err);
    }
  }

  // Auto-confirmar entrega se cliente não responder em 10 min
  private async autoConfirmExpiredDeliveries() {
    try {
      const count = await this.ordersService.autoConfirmExpiredDeliveries();
      if (count > 0) {
        this.logger.log(`Auto-confirmed ${count} deliveries (customer no response)`);
      }
    } catch (err) {
      this.logger.error('Failed to auto-confirm deliveries:', err);
    }
  }

  // Alertar vendedor se nenhum entregador aceitar em 15 min
  private async alertNoDeliverer() {
    try {
      const count = await this.ordersService.alertNoDeliverer();
      if (count > 0) {
        this.logger.log(`Alerted ${count} orders with no deliverer`);
      }
    } catch (err) {
      this.logger.error('Failed to alert no deliverer:', err);
    }
  }

  // KAN-205: re-tentar settlements que falharam (pedido COMPLETED mas isSettled=false)
  private async retryFailedSettlements() {
    try {
      const count = await this.ordersService.retryFailedSettlements();
      if (count > 0) {
        this.logger.log(`Retried settlement for ${count} order(s)`);
      }
    } catch (err) {
      this.logger.error('Failed to retry settlements:', err);
    }
  }
}
