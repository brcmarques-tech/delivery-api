import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';
import { Store } from '../../stores/entities/store.entity';
import { Category } from '../../categories/entities/category.entity';

@ObjectType()
@Entity('products')
export class Product {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  description: string;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  price: number;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  promotionalPrice: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  imageUrl: string;

  @Field()
  @Column({ default: true })
  isAvailable: boolean;

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field()
  @Column({ default: 0 })
  stock: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  unit: string; // kg, un, lt, etc.

  @Field({ nullable: true })
  @Column({ nullable: true })
  barcode: string;

  @Field()
  @Column({ default: false })
  isVariableWeight: boolean;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Store)
  @ManyToOne(() => Store, (store) => store.products)
  store: Store;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Category, { nullable: true })
  @ManyToOne(() => Category, (category) => category.products, { nullable: true })
  category: Category;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  @Field({ nullable: true })
  @DeleteDateColumn()
  deletedAt: Date;
}
