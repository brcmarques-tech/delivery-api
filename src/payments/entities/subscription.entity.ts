import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { VendorUser } from '../../users/entities/vendor-user.entity';
import { VendorPlan } from '../../common/enums';

@ObjectType('VendorSubscription')
@Entity('subscriptions')
export class Subscription {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => VendorUser)
  @ManyToOne(() => VendorUser, { eager: true })
  vendorUser: VendorUser;

  @Field()
  @Index({ unique: true })
  @Column({ unique: true })
  pagarmeSubscriptionId: string;

  @Column()
  pagarmePlanId: string;

  @Column()
  pagarmeCustomerId: string;

  @Field(() => VendorPlan)
  @Column({ type: 'enum', enum: VendorPlan })
  plan: VendorPlan;

  @Field()
  @Column()
  billingPeriod: string; // 'monthly' | 'quarterly' | 'semiannual' | 'annual'

  @Field()
  @Column({ default: 'pending' })
  status: string; // 'active' | 'canceled' | 'past_due' | 'pending' | 'failed'

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  currentPeriodStart: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  currentPeriodEnd: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  canceledAt: Date | null;

  @Field()
  @Column({ default: false })
  cancelAtPeriodEnd: boolean;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  amount: number;

  @Field(() => Int)
  @Column({ default: 1 })
  installments: number;

  @Field(() => String, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata: any;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
