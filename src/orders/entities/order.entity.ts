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

  @Field(() => AppUser)
  @ManyToOne(() => AppUser, (user) => user.orders)
  customer: AppUser;

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

  @Field(() => Coupon, { nullable: true })
  @ManyToOne(() => Coupon, { nullable: true })
  coupon: Coupon;

  @Field({ nullable: true })
  @Column({ nullable: true })
  customerConfirmedAt: Date;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
