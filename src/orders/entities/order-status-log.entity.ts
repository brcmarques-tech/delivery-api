import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Order } from './order.entity';
import { OrderStatus } from '../../common/enums';

@ObjectType()
@Entity('order_status_logs')
export class OrderStatusLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Order)
  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  order: Order;

  @Field(() => OrderStatus)
  @Column({ type: 'enum', enum: OrderStatus })
  fromStatus: OrderStatus;

  @Field(() => OrderStatus)
  @Column({ type: 'enum', enum: OrderStatus })
  toStatus: OrderStatus;

  @Field()
  @Column()
  changedBy: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  reason: string;

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
