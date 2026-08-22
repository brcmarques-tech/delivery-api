import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  CreateDateColumn,
  Unique,
  Index,
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

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => AppUser)
  @ManyToOne(() => AppUser, { onDelete: 'CASCADE' })
  user: AppUser;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Store)
  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  store: Store;

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
