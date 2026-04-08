import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import {
  WhatsAppAgentService,
  WahaMessagePayload,
} from './whatsapp-agent.service';

@Controller('whatsapp-agent')
export class WhatsAppAgentController {
  private readonly logger = new Logger(WhatsAppAgentController.name);

  constructor(private readonly agentService: WhatsAppAgentService) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Body() body: any): Promise<{ ok: boolean }> {
    // WAHA sends event wrapped in { event, payload }
    const event = body?.event ?? body?.type;
    const payload = body?.payload ?? body;

    if (event !== 'message') {
      return { ok: true };
    }

    const msg = payload as any;
    if (!msg?.from || !msg?.body || msg?.fromMe) {
      return { ok: true };
    }

    // WhatsApp new LID format: resolve to real phone via remoteJidAlt
    let from: string = msg.from;
    if (from.endsWith('@lid')) {
      const alt: string = msg._data?.key?.remoteJidAlt ?? '';
      if (alt) from = alt.replace(/@.*$/, '');
    }

    const wahaPayload: WahaMessagePayload = {
      id: msg.id ?? '',
      from,
      to: msg.to ?? msg.session ?? '',
      body: msg.body,
      timestamp: msg.timestamp ?? Date.now(),
      fromMe: msg.fromMe ?? false,
      type: msg.type ?? 'text',
    };

    await this.agentService.enqueueMessage(wahaPayload);
    this.logger.log(`Mensagem de ${wahaPayload.from} enfileirada`);
    return { ok: true };
  }
}
