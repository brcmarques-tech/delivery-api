import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Product } from '../../products/entities/product.entity';
import { Category } from '../../categories/entities/category.entity';

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

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  deliveryFee: number;

  @Field()
  @Column({ default: 30 })
  estimatedDeliveryMinutes: number;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  minimumOrder: number;

  @Field(() => User)
  @ManyToOne(() => User, (user) => user.stores)
  owner: User;

  @Field(() => [Product], { nullable: true })
  @OneToMany(() => Product, (product) => product.store)
  products: Product[];

  @Field(() => [Category], { nullable: true })
  @OneToMany(() => Category, (category) => category.store)
  categories: Category[];

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
