import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly session: string;

  constructor(private configService: ConfigService) {
    this.apiUrl = this.configService.get('WAHA_API_URL', 'http://localhost:3003');
    this.apiKey = this.configService.get('WAHA_API_KEY', '');
    this.session = this.configService.get('WAHA_SESSION', 'default');
  }

  private get enabled(): boolean {
    return !!(this.apiUrl && this.apiKey);
  }

  private formatPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.startsWith('55')) return digits;
    return `55${digits}`;
  }

  async sendText(to: string, text: string): Promise<boolean> {
    if (!this.enabled) {
      this.logger.warn('WhatsApp desabilitado: WAHA_API_URL ou WAHA_API_KEY não configurados');
      return false;
    }

    try {
      const res = await fetch(`${this.apiUrl}/api/sendText`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
        },
        body: JSON.stringify({
          session: this.session,
          chatId: `${this.formatPhone(to)}@c.us`,
          text,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        this.logger.error(`WhatsApp erro: ${JSON.stringify(data)}`);
        return false;
      }

      this.logger.log(`WhatsApp enviado para ${to} | msgId: ${data.key?.id}`);
      return true;
    } catch (err: any) {
      this.logger.error(`WhatsApp falhou para ${to}: ${err.message}`);
      return false;
    }
  }

  // ---- Notificações do delivery ----

  async notifyOrderConfirmed(phone: string, orderNumber: string, storeName: string): Promise<boolean> {
    return this.sendText(
      phone,
      `✅ *Pedido #${orderNumber} confirmado!*\n\n` +
      `Seu pedido na *${storeName}* foi aceito e está sendo preparado.\n\n` +
      `Acompanhe pelo app!`,
    );
  }

  async notifyOrderReady(phone: string, orderNumber: string): Promise<boolean> {
    return this.sendText(
      phone,
      `🍽️ *Pedido #${orderNumber} pronto!*\n\n` +
      `Seu pedido está pronto e aguardando o entregador.`,
    );
  }

  async notifyOrderDelivering(phone: string, orderNumber: string, delivererName: string): Promise<boolean> {
    return this.sendText(
      phone,
      `🛵 *Pedido #${orderNumber} saiu para entrega!*\n\n` +
      `O entregador *${delivererName}* está a caminho com seu pedido.`,
    );
  }

  async notifyOrderDelivered(phone: string, orderNumber: string): Promise<boolean> {
    return this.sendText(
      phone,
      `📦 *Pedido #${orderNumber} entregue!*\n\n` +
      `Seu pedido foi entregue. Bom apetite! 😋\n` +
      `Avalie sua experiência no app.`,
    );
  }

  async notifyNewOrderToVendor(phone: string, orderNumber: string, total: string): Promise<boolean> {
    return this.sendText(
      phone,
      `🔔 *Novo pedido #${orderNumber}!*\n\n` +
      `Valor: *R$ ${total}*\n\n` +
      `Acesse o painel para aceitar o pedido.`,
    );
  }

  async notifyNewDeliveryAvailable(phone: string, orderNumber: string, deliveryFee: string): Promise<boolean> {
    return this.sendText(
      phone,
      `🛵 *Nova entrega disponível!*\n\n` +
      `Pedido #${orderNumber}\n` +
      `Taxa de entrega: *R$ ${deliveryFee}*\n\n` +
      `Aceite pelo app!`,
    );
  }
}
