import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { VendorUser } from '../../users/entities/vendor-user.entity';
import { Product } from '../../products/entities/product.entity';
import { Category } from '../../categories/entities/category.entity';
import { VerificationLevel } from '../../common/enums/verification-level.enum';

@ObjectType()
@Entity('stores')
export class Store {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  description: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  logoUrl: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  bannerUrl: string;

  @Field()
  @Column()
  phone: string;

  @Field()
  @Column()
  street: string;

  @Field()
  @Column()
  number: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  complement: string;

  @Field()
  @Column()
  neighborhood: string;

  @Field()
  @Column()
  city: string;

  @Field()
  @Column()
  state: string;

  @Field()
  @Column()
  zipCode: string;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 7 })
  latitude: number;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 7 })
  longitude: number;

  @Field()
  @Column({ default: true })
  isOpen: boolean;

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field()
  @Column({ default: false })
  hasOwnDelivery: boolean;

  @Field()
  @Column({ default: false })
  freeDelivery: boolean;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  deliveryFee: number;

  @Field()
  @Column({ default: 30 })
  estimatedDeliveryMinutes: number;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  minimumOrder: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deliveryStartTime: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deliveryEndTime: string;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  freeDeliveryAbove: number;

  @Field(() => VerificationLevel)
  @Column({ type: 'varchar', default: VerificationLevel.NONE })
  verificationLevel: VerificationLevel;

  @Field(() => Int)
  @Column({ default: 0 })
  verificationScore: number;

  @Field(() => Int)
  @Column({ default: 0 })
  totalSales: number;

  @Field(() => Int)
  @Column({ default: 0 })
  totalProducts: number;

  @Field(() => Int)
  @Column({ default: 0 })
  badgeClaimCount: number;

  @Field(() => Int)
  @Column({ default: 0 })
  lastClaimedScore: number;

  @Field(() => Int)
  @Column({ default: 0 })
  freePromoDaysCredit: number;

  @Field(() => Float)
  @Column('decimal', { precision: 5, scale: 2, default: 0 })
  commissionReductionPercent: number;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  commissionReductionExpiresAt: Date | null;

  // Token para confirmacao de exclusao
  @Column({ nullable: true })
  deleteToken: string;

  @Column({ type: 'timestamp', nullable: true })
  deleteTokenExpires: Date;

  @Field(() => VendorUser)
  @ManyToOne(() => VendorUser, (user) => user.stores)
  owner: VendorUser;

  @Field(() => [Product], { nullable: true })
  @OneToMany(() => Product, (product) => product.store)
  products: Product[];

  @Field(() => [Category], { nullable: true })
  @OneToMany(() => Category, (category) => category.store)
  categories: Category[];

  @Field(() => Boolean)
  ownerMpConnected: boolean;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
