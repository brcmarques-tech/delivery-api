import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  JoinColumn,
} from 'typeorm';
import { AppUser } from '../../users/entities/app-user.entity';

@ObjectType()
@Entity('saved_cards')
export class SavedCard {
  @Field(() => ID)
  @PrimaryColumn()
  id: string; // Pagar.me card ID (card_xxx)

  @ManyToOne(() => AppUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: AppUser;

  @Column()
  userId: string;

  @Field()
  @Column()
  lastFourDigits: string;

  @Field()
  @Column()
  brand: string;

  @Field()
  @Column()
  holderName: string;

  @Field(() => Int)
  @Column()
  expMonth: number;

  @Field(() => Int)
  @Column()
  expYear: number;

  @CreateDateColumn()
  createdAt: Date;
}
