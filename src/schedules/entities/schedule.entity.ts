import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { Store } from '../../stores/entities/store.entity';

@ObjectType()
@Entity('schedules')
@Unique(['storeId', 'dayOfWeek'])
export class Schedule {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => Store)
  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'storeId' })
  store: Store;

  @Column()
  storeId: string;

  @Field(() => Int)
  @Column()
  dayOfWeek: number; // 0=Dom, 1=Seg, ..., 6=Sab

  @Field()
  @Column()
  startTime: string; // "08:00"

  @Field()
  @Column()
  endTime: string; // "18:00"

  @Field()
  @Column({ default: true })
  isActive: boolean;
}
