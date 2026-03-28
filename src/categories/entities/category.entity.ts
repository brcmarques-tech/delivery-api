import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
} from 'typeorm';
import { Store } from '../../stores/entities/store.entity';
import { Product } from '../../products/entities/product.entity';

@ObjectType()
@Entity('categories')
export class Category {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  imageUrl: string;

  @Field()
  @Column({ default: 0 })
  sortOrder: number;

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field()
  @Column({ default: false })
  requiresAgeVerification: boolean;

  @Field(() => Store)
  @ManyToOne(() => Store, (store) => store.categories)
  store: Store;

  @Field(() => [Product], { nullable: true })
  @OneToMany(() => Product, (product) => product.category)
  products: Product[];

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
