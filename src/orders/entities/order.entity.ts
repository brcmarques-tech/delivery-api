import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
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

  @Column({ default: false })
  couponCredited: boolean;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
