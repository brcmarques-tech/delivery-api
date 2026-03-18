import { Controller, Post, Get, Body, Query, Res, Headers, HttpCode, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as express from 'express';
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

    if (webhookUser && webhookPass) {
      const expected = 'Basic ' + Buffer.from(`${webhookUser}:${webhookPass}`).toString('base64');
      if (authHeader !== expected) {
        this.logger.warn('Webhook auth failed - invalid credentials');
        throw new UnauthorizedException('Invalid webhook credentials');
      }
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
    res.redirect(`delivery-app://order-result?status=${status || 'unknown'}&order=${orderId || ''}`);
  }
}
