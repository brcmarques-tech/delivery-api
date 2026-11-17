import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  DeleteDateColumn,
} from 'typeorm';
import { Store } from '../../stores/entities/store.entity';

@ObjectType()
@Entity('schedules')
// KAN-326: um horário por dia da semana só entre os não excluídos
@Index('UQ_schedules_store_dia_ativo', ['storeId', 'dayOfWeek'], { unique: true, where: '"deletedAt" IS NULL' })
export class Schedule {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
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

  // KAN-326: soft delete — nada de negócio é apagado de vez; pode ser restaurado.
  @DeleteDateColumn({ nullable: true })
  deletedAt?: Date;
}
