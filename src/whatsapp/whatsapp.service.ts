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
    let digits = phone.replace(/\D/g, '');
    if (!digits.startsWith('55')) digits = `55${digits}`;
    // WhatsApp BR: celulares com 9 digitos (55 + DDD + 9XXXX-XXXX = 13 digitos)
    // sao registrados no WhatsApp sem o nono digito (55 + DDD + XXXX-XXXX = 12 digitos)
    if (digits.length === 13 && digits[4] === '9') {
      digits = digits.slice(0, 4) + digits.slice(5);
    }
    return digits;
  }

  async sendText(to: string, text: string): Promise<boolean> {
    if (!this.enabled) {
      this.logger.warn(`WhatsApp desabilitado: apiUrl=${this.apiUrl} apiKey=${this.apiKey ? 'SET' : 'EMPTY'}`);
      return false;
    }

    const phone = this.formatPhone(to);
    const url = `${this.apiUrl}/api/sendText`;
    this.logger.log(`WhatsApp tentando enviar para ${phone} via ${url}`);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
        },
        body: JSON.stringify({
          session: this.session,
          chatId: `${phone}@c.us`,
          text,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        this.logger.error(`WhatsApp erro ${res.status}: ${JSON.stringify(data)}`);
        return false;
      }

      this.logger.log(`WhatsApp enviado para ${to} | msgId: ${data.key?.id}`);
      return true;
    } catch (err: any) {
      this.logger.error(`WhatsApp falhou para ${to} (${url}): ${err.message}`);
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

  // ---- Notificações de aprovação/rejeição ----

  async notifyUserApproved(phone: string, name: string, role: string): Promise<boolean> {
    const roleLabel = role === 'DELIVERER' ? 'entregador' : role === 'VENDOR' ? 'vendedor' : role.toLowerCase();
    return this.sendText(
      phone,
      `✅ *Cadastro aprovado!*\n\n` +
      `Olá *${name}*, seu cadastro como *${roleLabel}* foi aprovado!\n\n` +
      `Você já pode acessar todas as funcionalidades.`,
    );
  }

  async notifyUserRejected(phone: string, name: string, role: string, reason: string): Promise<boolean> {
    const roleLabel = role === 'DELIVERER' ? 'entregador' : role === 'VENDOR' ? 'vendedor' : role.toLowerCase();
    return this.sendText(
      phone,
      `❌ *Cadastro não aprovado*\n\n` +
      `Olá *${name}*, infelizmente seu cadastro como *${roleLabel}* não foi aprovado.\n\n` +
      `Motivo: ${reason}\n\n` +
      `Você pode tentar novamente corrigindo as informações.`,
    );
  }

  // ---- Notificação de reset de senha ----

  async notifyPasswordReset(phone: string, name: string, resetUrl: string): Promise<boolean> {
    return this.sendText(
      phone,
      `🔑 *Recuperação de senha*\n\n` +
      `Olá *${name}*, clique no link abaixo para redefinir sua senha:\n\n` +
      `${resetUrl}\n\n` +
      `O link expira em 1 hora.`,
    );
  }

  // ---- Notificações de loja ----

  async notifyStoreDeleteRequest(phone: string, name: string, storeName: string, confirmUrl: string): Promise<boolean> {
    return this.sendText(
      phone,
      `⚠️ *Exclusão de loja solicitada*\n\n` +
      `Olá *${name}*, foi solicitada a exclusão da loja *${storeName}*.\n\n` +
      `Confirme clicando no link:\n${confirmUrl}\n\n` +
      `O link expira em 30 minutos.`,
    );
  }

  // ---- Notificações de plano ----

  async notifyPlanUpgrade(phone: string, name: string, plan: string, billingLabel: string): Promise<boolean> {
    return this.sendText(
      phone,
      `⭐ *Upgrade de plano!*\n\n` +
      `Olá *${name}*, seu checkout para o plano *${plan}* (${billingLabel}) foi gerado.\n\n` +
      `Finalize o pagamento para ativar seu plano!`,
    );
  }

  // ---- Notificações de promoção ----

  async notifyPromotionCreated(phone: string, storeName: string, promoTitle: string, adCost: string): Promise<boolean> {
    const costMsg = parseFloat(adCost) > 0
      ? `Custo do anúncio: *R$ ${adCost}*\nFinalize o pagamento para ativar.`
      : `Promoção gratuita! Já está ativa.`;
    return this.sendText(
      phone,
      `📢 *Promoção criada!*\n\n` +
      `Loja: *${storeName}*\n` +
      `Promoção: *${promoTitle}*\n\n` +
      `${costMsg}`,
    );
  }

  async notifyPromotionPaid(phone: string, promoTitle: string): Promise<boolean> {
    return this.sendText(
      phone,
      `✅ *Promoção ativada!*\n\n` +
      `Sua promoção *${promoTitle}* foi paga e está ativa!\n\n` +
      `Os clientes já podem ver no app.`,
    );
  }

  // ---- Notificações de selo/badge ----

  async notifyBadgeReward(phone: string, storeName: string, level: string): Promise<boolean> {
    return this.sendText(
      phone,
      `🏆 *Recompensa resgatada!*\n\n` +
      `A loja *${storeName}* resgatou a recompensa do nível *${level}*!\n\n` +
      `Confira os benefícios no painel.`,
    );
  }
}
