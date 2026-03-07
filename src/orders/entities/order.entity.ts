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
import { User } from '../../users/entities/user.entity';
import { Store } from '../../stores/entities/store.entity';
import { OrderItem } from './order-item.entity';
import { Delivery } from '../../deliveries/entities/delivery.entity';
import { Address } from '../../addresses/entities/address.entity';

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

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  platformCommission: number;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  platformDeliveryFee: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  notes: string;

  @Field()
  @Column()
  deliveryAddress: string;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 7 })
  deliveryLatitude: number;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 7 })
  deliveryLongitude: number;

  @Field(() => User)
  @ManyToOne(() => User, (user) => user.orders)
  customer: User;

  @Field(() => Store)
  @ManyToOne(() => Store)
  store: Store;

  @Field(() => [OrderItem])
  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];

  @Field(() => Delivery, { nullable: true })
  @OneToOne(() => Delivery, (delivery) => delivery.order)
  delivery: Delivery;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
