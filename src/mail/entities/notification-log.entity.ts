import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@ObjectType()
@Entity('notification_logs')
export class NotificationLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  type: string; // EMAIL

  @Field()
  @Column()
  to: string;

  @Field()
  @Column()
  userName: string;

  @Field()
  @Column()
  subject: string;

  @Field()
  @Column({ type: 'text' })
  message: string;

  @Field()
  @Column({ default: true })
  success: boolean;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  error: string | null;

  @Field()
  @Column({ default: 0 })
  retryCount: number;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date | null;
}
