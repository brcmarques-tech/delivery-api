import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Order } from '../../orders/entities/order.entity';

@ObjectType()
@Entity('deliveries')
export class Delivery {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  currentLatitude: number;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  currentLongitude: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  pickedUpAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deliveredAt: Date;

  @Field(() => User)
  @ManyToOne(() => User)
  deliverer: User;

  @Field(() => Order)
  @OneToOne(() => Order, (order) => order.delivery)
  @JoinColumn()
  order: Order;

  @Field({ nullable: true })
  @Column({ nullable: true })
  payoutStatus: string; // 'pending_confirmation' | 'completed' | 'failed'

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  payoutAmount: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  payoutMpId: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  vendorPayoutStatus: string; // 'completed' | 'failed'

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  vendorPayoutAmount: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  vendorPayoutMpId: string;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
