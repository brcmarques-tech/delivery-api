import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Body() body: any): Promise<{ ok: boolean }> {
    await this.paymentsService.handleWebhook(body);
    return { ok: true };
  }
}
