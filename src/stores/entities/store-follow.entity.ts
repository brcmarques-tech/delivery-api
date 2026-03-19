import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  CreateDateColumn,
  Unique,
} from 'typeorm';
import { AppUser } from '../../users/entities/app-user.entity';
import { Store } from './store.entity';

@ObjectType()
@Entity('store_follows')
@Unique(['user', 'store'])
export class StoreFollow {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => AppUser)
  @ManyToOne(() => AppUser, { onDelete: 'CASCADE' })
  user: AppUser;

  @Field(() => Store)
  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  store: Store;

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
