import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Coupon } from '../coupons/entities/coupon.entity';
import { Order } from '../orders/entities/order.entity';
import { FidelidadeService } from './fidelidade.service';
import { FidelidadeResolver } from './fidelidade.resolver';
import { NotificationsModule } from '../notifications/notifications.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

/**
 * KAN-12. Módulo próprio (e não dentro de coupons/) porque fidelidade ATRAVESSA
 * pedido, cupom e notificação: deixá-la dentro de um dos três faria aquele
 * módulo depender dos outros dois sem motivo.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Coupon, Order]),
    NotificationsModule,
    WhatsAppModule,
  ],
  providers: [FidelidadeService, FidelidadeResolver],
  exports: [FidelidadeService],
})
export class FidelidadeModule {}
