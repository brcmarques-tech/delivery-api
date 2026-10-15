import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  OneToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { OrderStatus } from '../../common/enums';
import { AppUser } from '../../users/entities/app-user.entity';
import { Store } from '../../stores/entities/store.entity';
import { OrderItem } from './order-item.entity';
import { Delivery } from '../../deliveries/entities/delivery.entity';
import { Address } from '../../addresses/entities/address.entity';
import { Coupon } from '../../coupons/entities/coupon.entity';

@ObjectType()
@Entity('orders')
export class Order {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ unique: true })
  orderNumber: string;

  // Perf (F5): status e o filtro mais quente da tabela — availableDeliveries
  // (READY), schedulers de expiracao/auto-confirmacao e o painel filtram por ele.
  // Sem indice era sequential scan crescendo com o volume de pedidos.
  @Index()
  @Field(() => OrderStatus)
  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  subtotal: number;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  deliveryFee: number;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  total: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  paymentMethod: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  checkoutUrl: string;

  // TODO: Rename mpPreferenceId to pagarmeOrderId in a future migration (legacy MP naming)
  @Field({ nullable: true })
  @Column({ nullable: true })
  mpPreferenceId: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  pixQrCode: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  pixQrCodeBase64: string;

  @Field()
  @Column({ default: false })
  isPickup: boolean;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 5, scale: 2, nullable: true })
  commissionPercent: number;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  commissionAmount: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  notes: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deliveryAddress: string;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  deliveryLatitude: number;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  deliveryLongitude: number;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => AppUser)
  @ManyToOne(() => AppUser, (user) => user.orders)
  customer: AppUser;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Store)
  @ManyToOne(() => Store)
  store: Store;

  @Field(() => [OrderItem])
  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];

  @Field(() => Delivery, { nullable: true })
  @OneToOne(() => Delivery, (delivery) => delivery.order)
  delivery: Delivery;

  @Field({ nullable: true })
  @Column({ nullable: true })
  couponCode: string;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  discount: number;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Coupon, { nullable: true })
  @ManyToOne(() => Coupon, { nullable: true })
  coupon: Coupon;

  @Field({ nullable: true })
  @Column({ nullable: true })
  customerConfirmedAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  vendorConfirmedPickupAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  delivererConfirmedDeliveryAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  completedAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  disputedAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  disputeReason: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  disputeResolution: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  disputeResolvedAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  rejectedAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  rejectionReason: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  estimatedPickupEta: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  estimatedDeliveryEta: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  preAuthChargeId: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  capturedAt: Date;

  @Field()
  @Column({ default: false })
  isSettled: boolean;

  // Registra COMO o pedido foi liquidado. Antes isso era inferido de
  // `capturedAt` — premissa falsa: no caminho do antifraude (PAYMENT_REVIEW
  // aprovado no painel) o Pagar.me captura sozinho e grava `capturedAt` SEM
  // nenhum split, e o repasse sai depois por /transfers manual. Na hora do
  // estorno/chargeback o codigo via `capturedAt` e presumia "split reverte
  // sozinho", entao NAO revertia os repasses: a plataforma devolvia ao cliente
  // e perdia tambem o valor ja transferido a vendedor e entregador.
  @Column({ default: false })
  settledViaSplit: boolean;

  // Quem JA recebeu, por parte. O booleano `isSettled` sozinho nao distinguia
  // "nada saiu" de "metade saiu": bastava uma das duas transferencias falhar
  // para ele voltar a false, mesmo com a outra ja efetivada. Isso fazia o
  // chargeback pular a reversao do que ja tinha saido (prejuizo direto da
  // plataforma) e o retry re-enviar a transferencia que ja tinha dado certo.
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  vendorSettledAt: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  delivererSettledAt: Date;

  // Repasse de entregador RETIDO na plataforma.
  //
  // No PIX com split-on-charge o entregador não entra na divisão da cobrança (só
  // é conhecido no READY, depois do pagamento já dividido), então o frete dele
  // fica com a plataforma e precisa de repasse manual. Antes isso existia apenas
  // como texto em `notes` — impossível somar, filtrar ou dar baixa. Agora é um
  // passivo de primeira classe.
  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  delivererPayableCents: number;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  delivererPayablePaidAt: Date;

  // Foto do valor que o cliente JA pagou/autorizou online, tirada no PRIMEIRO
  // ajuste de peso (adjustItemWeight e o unico lugar que muda `total` depois da
  // criacao — depois do primeiro ajuste o `total` deixa de dizer quanto foi
  // cobrado). Null = pedido nunca ajustado, ou pago na entrega.
  // E o teto da captura no cartao e a referencia do reembolso parcial no PIX.
  @Field(() => Number, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  onlinePaidTotal: number | null;

  // Guarda de idempotencia do reembolso parcial de peso (pago > total final).
  // Mesmo papel dos vendorSettledAt/delivererSettledAt para as transferencias.
  @Column({ type: 'timestamp', nullable: true })
  overpaidRefundedAt: Date | null;

  @Column({ default: false })
  couponCredited: boolean;

  // Guarda de idempotência da RESTAURAÇÃO de estoque+cupom no cancelamento.
  // (auditoria 2026-08-23) Antes, dois fluxos concorrentes de cancelamento
  // (ex.: cliente cancela + expirePendingOrders varre o mesmo pedido) liam ambos
  // o status já terminal e chamavam restoreStockAndCoupon os DOIS: estoque
  // devolvido 2x (fantasma -> oversell) e decrementUsage do cupom 2x. Este
  // timestamp é fincado por claim atômico — só o primeiro fluxo restaura.
  @Column({ type: 'timestamp', nullable: true })
  stockRestoredAt: Date | null;

  // ─── Garantia de entrega por CÓDIGOS ──────────────────────────────────
  //
  // ATENÇÃO — NENHUM DESTES CAMPOS TEM @Field(), E ISSO É DELIBERADO.
  //
  // Se um código virar campo do tipo `Order` no GraphQL, qualquer query que
  // retorne o pedido o entrega junto — e a query do ENTREGADOR passaria a
  // trazer o código do CLIENTE, que é exatamente o segredo que ele tem de
  // receber da pessoa. Isso destruiria o esquema inteiro, e não é hipótese
  // remota: este projeto já vazou dado sensível desse jeito três vezes (PII em
  // `serviceRatings`, endereço do cliente em broadcast para todo socket
  // conectado, e permissões de superadmin que só existiam na UI).
  //
  // Cada parte lê o SEU código por uma query dedicada, que valida posse e
  // devolve só aquele valor. Ver DeliveryCodesService.
  //
  // Só pedidos com entrega por entregador do app recebem códigos; a presença
  // deles é o que chaveia entre o fluxo novo e o antigo.

  /** Visível só ao LOJISTA. O ENTREGADOR digita na coleta. */
  @Column({ type: 'varchar', length: 6, nullable: true })
  codigoVendedor: string | null;

  /** Visível só ao ENTREGADOR. O LOJISTA digita na coleta. */
  @Column({ type: 'varchar', length: 6, nullable: true })
  codigoEntregador: string | null;

  /** Visível só ao CLIENTE. O ENTREGADOR digita na porta — é o que LIBERA o dinheiro. */
  @Column({ type: 'varchar', length: 6, nullable: true })
  codigoCliente: string | null;

  @Column({ type: 'timestamp', nullable: true })
  codigoVendedorUsadoEm: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  codigoEntregadorUsadoEm: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  codigoClienteUsadoEm: Date | null;

  // Onde o entregador estava em cada registro. É a evidência que sustenta a
  // contestação de chargeback (KAN-303: recuperar repasse é impossível, então a
  // defesa é a prova de entrega).
  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  codigoVendedorLat: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  codigoVendedorLng: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  codigoClienteLat: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  codigoClienteLng: number | null;

  /** Tentativas erradas acumuladas NESTE pedido (contador compartilhado). */
  @Column({ type: 'int', default: 0 })
  codigoTentativas: number;

  @Column({ type: 'timestamp', nullable: true })
  codigoBloqueadoAte: Date | null;

  /**
   * Entrega registrada SEM o código do cliente (ausente, dormindo, ou que se
   * recusa a informar).
   *
   * Existe para o pagamento do entregador não ficar preso à boa vontade do
   * cliente — isso derrubaria retenção de entregador rápido. Abre janela de
   * contestação: sem contestação do cliente, libera; com contestação, a
   * plataforma decide com a foto, o GPS e o horário.
   */
  @Column({ type: 'timestamp', nullable: true })
  entregaSemCodigoEm: Date | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  entregaSemCodigoMotivo: string | null;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
