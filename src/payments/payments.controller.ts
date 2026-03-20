import { Controller, Post, Get, Body, Query, Res, Headers, HttpCode, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as express from 'express';
import * as crypto from 'crypto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private paymentsService: PaymentsService,
    private configService: ConfigService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Body() body: any,
    @Headers('authorization') authHeader: string,
  ): Promise<{ ok: boolean }> {
    const webhookUser = this.configService.get('PAGARME_WEBHOOK_USER');
    const webhookPass = this.configService.get('PAGARME_WEBHOOK_PASS');

    if (!webhookUser || !webhookPass) {
      this.logger.error('Webhook rejected - PAGARME_WEBHOOK_USER/PASS not configured');
      throw new UnauthorizedException('Webhook credentials not configured');
    }

    const expected = 'Basic ' + Buffer.from(`${webhookUser}:${webhookPass}`).toString('base64');
    const authBuf = Buffer.from(authHeader || '');
    const expectedBuf = Buffer.from(expected);
    if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
      this.logger.warn('Webhook auth failed - invalid credentials');
      throw new UnauthorizedException('Invalid webhook credentials');
    }

    // M2: Validate webhook body structure before processing
    if (!body || typeof body.type !== 'string' || !body.data || typeof body.data !== 'object') {
      this.logger.warn(`Webhook rejected - malformed body: type=${typeof body?.type} data=${typeof body?.data}`);
      return { ok: false };
    }

    await this.paymentsService.handleWebhook(body);
    return { ok: true };
  }

  @Get('order-result')
  async orderResult(
    @Query('status') status: string,
    @Query('order') orderId: string,
    @Res() res: express.Response,
  ): Promise<void> {
    const safeStatus = encodeURIComponent((status || 'unknown').replace(/[^a-zA-Z0-9_-]/g, ''));
    const safeOrderId = encodeURIComponent((orderId || '').replace(/[^a-zA-Z0-9_-]/g, ''));
    res.redirect(`delivery-app://order-result?status=${safeStatus}&order=${safeOrderId}`);
  }
}
