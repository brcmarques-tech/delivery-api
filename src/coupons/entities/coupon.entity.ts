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
import { Store } from '../../stores/entities/store.entity';

@ObjectType()
@Entity('coupons')
export class Coupon {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  code: string; // e.g. "DESCONTO10"

  @Field()
  @Column({ default: 'PERCENT' })
  discountType: string; // 'PERCENT' | 'FIXED'

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  discountValue: number; // e.g. 10 = 10% or R$10

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  minimumOrder: number; // min subtotal to use coupon

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  maxDiscount: number; // cap for PERCENT type (e.g. max R$50)

  @Field(() => Int)
  @Column({ default: 0 })
  maxUses: number; // 0 = unlimited

  @Field(() => Int)
  @Column({ default: 0 })
  usesCount: number;

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  expiresAt: Date;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Store)
  @ManyToOne(() => Store)
  store: Store;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
