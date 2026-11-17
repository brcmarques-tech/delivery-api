import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ContaService } from './conta.service';
import { ContaResolver } from './conta.resolver';

/** KAN-326 / LGPD: exclusão de conta pelo titular (anonimização). */
@Module({
  imports: [PaymentsModule],
  providers: [ContaService, ContaResolver],
})
export class ContaModule {}
