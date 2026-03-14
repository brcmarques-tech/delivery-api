import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';
import { AppUser } from '../../users/entities/app-user.entity';
import { VendorUser } from '../../users/entities/vendor-user.entity';

@ObjectType()
@Entity('payments')
export class Payment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  type: string; // 'PLAN_UPGRADE' | 'PROMOTION' | 'VENDOR_PAYOUT' | 'DELIVERER_PAYOUT'

  @Field()
  @Column()
  description: string;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  amount: number;

  @Field()
  @Column({ default: 'pending' })
  status: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  mpPaymentId: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  mpPreferenceId: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  checkoutUrl: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: any;

  @Field(() => AppUser, { nullable: true })
  @ManyToOne(() => AppUser, { nullable: true })
  appUser: AppUser;

  @Field(() => VendorUser, { nullable: true })
  @ManyToOne(() => VendorUser, { nullable: true })
  vendorUser: VendorUser;

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
