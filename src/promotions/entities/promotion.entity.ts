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

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  price: number;

  @Field()
  @Column({ default: false })
  isPaid: boolean;

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
