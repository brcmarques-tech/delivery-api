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

  @Get('mp/connect-url')
  getMpConnectUrl(@Query('userId') userId: string): { url: string } {
    const url = this.paymentsService.getMpConnectUrl(userId);
    return { url };
  }

  @Get('mp/callback')
  async handleMpCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: express.Response,
  ): Promise<void> {
    const [userId, source] = state.split(':');
    await this.paymentsService.handleMpOAuthCallback(code, userId);
    if (source === 'app') {
      res.redirect('delivery-app://profile?mp=connected');
    } else {
      const vendorUrl = this.configService.get('VENDOR_APP_URL') || 'http://localhost:3001';
      res.redirect(`${vendorUrl}/dashboard?mp=connected`);
    }
  }
}
