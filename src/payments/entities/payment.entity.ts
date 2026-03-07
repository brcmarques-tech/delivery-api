import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@ObjectType()
@Entity('payments')
export class Payment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  type: string; // 'PLAN_UPGRADE' | 'PROMOTION'

  @Field()
  @Column()
  description: string;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  amount: number;

  @Field()
  @Column({ default: 'pending' })
  status: string; // 'pending' | 'approved' | 'rejected'

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

  @Field(() => User)
  @ManyToOne(() => User)
  user: User;

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
