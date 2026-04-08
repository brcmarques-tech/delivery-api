import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WhatsAppAgentService,
  WahaMessagePayload,
} from './whatsapp-agent.service';

@Controller('whatsapp-agent')
export class WhatsAppAgentController {
  private readonly logger = new Logger(WhatsAppAgentController.name);

  constructor(
    private readonly agentService: WhatsAppAgentService,
    private readonly configService: ConfigService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Body() body: any,
    @Headers('x-waha-key') wahaKey: string,
  ): Promise<{ ok: boolean }> {
    const secret = this.configService.get<string>('WAHA_WEBHOOK_SECRET');
    if (secret && wahaKey !== secret) {
      this.logger.warn(
        `WAHA webhook auth failed — received key: "${wahaKey}", expected: "${secret}"`,
      );
      throw new UnauthorizedException('Invalid webhook key');
    }

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

    const wahaPayload: WahaMessagePayload = {
      id: msg.id ?? '',
      from: msg.from,
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
