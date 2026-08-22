import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index, Unique, JoinColumn } from 'typeorm';
import { Store } from '../../stores/entities/store.entity';

@ObjectType()
// Unicidade real no banco (migration 1785600000000). Antes era so uma checagem
// read-then-write no service, sem constraint — dois cupons de mesmo codigo na
// mesma loja eram possiveis, e o update sequer re-checava.
@Unique('UQ_coupons_code_store', ['code', 'storeId'])
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
  @JoinColumn({ name: 'storeId' })
  store: Store;

  // Coluna FK declarada para o @Unique('code','storeId') acima poder referencia-la
  // (o TypeORM exige a propriedade na entity, nao so a relacao).
  @Column()
  storeId: string;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
