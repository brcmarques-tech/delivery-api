import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';
import { AppUser } from '../../users/entities/app-user.entity';
import { Product } from '../../products/entities/product.entity';
import { Store } from '../../stores/entities/store.entity';

@ObjectType()
@Entity('cart_items')
@Unique(['customer', 'product'])
export class CartItem {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => Int)
  @Column({ default: 1 })
  quantity: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  notes: string;

  @Field(() => Int, { nullable: true })
  @Column({ nullable: true })
  weightGrams: number;

  @Field(() => AppUser)
  @ManyToOne(() => AppUser, { onDelete: 'CASCADE' })
  customer: AppUser;

  @Field(() => Product)
  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  product: Product;

  @Field(() => Store)
  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  store: Store;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
