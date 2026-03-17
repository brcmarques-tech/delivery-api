import { Controller, Post, Get, Body, Query, Res, HttpCode } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as express from 'express';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(
    private paymentsService: PaymentsService,
    private configService: ConfigService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Body() body: any): Promise<{ ok: boolean }> {
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
