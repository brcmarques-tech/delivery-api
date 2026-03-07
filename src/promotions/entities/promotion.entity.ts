import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Store } from '../../stores/entities/store.entity';
import { Product } from '../../products/entities/product.entity';

@ObjectType()
@Entity('promotions')
export class Promotion {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  title: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  description: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  imageUrl: string;

  @Field()
  @Column()
  startDate: Date;

  @Field()
  @Column()
  endDate: Date;

  @Field()
  @Column({ default: true })
  isActive: boolean;

  /** Preco promocional do produto definido pelo vendedor */
  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  promotionalPrice: number;

  /** Custo do anuncio (dias * preco por dia) */
  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  adCost: number;

  /** @deprecated Mantido para compatibilidade com registros antigos */
  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  price: number;

  @Field()
  @Column({ default: false })
  isPaid: boolean;

  @Field(() => Store)
  @ManyToOne(() => Store)
  store: Store;

  @Field(() => Product, { nullable: true })
  @ManyToOne(() => Product, { nullable: true })
  product: Product;

  @Field({ nullable: true })
  @Column({ nullable: true })
  checkoutUrl: string;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
