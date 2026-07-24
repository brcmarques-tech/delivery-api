import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Unique,
  Index,
} from 'typeorm';
import { AppUser } from '../../users/entities/app-user.entity';
import { Store } from '../../stores/entities/store.entity';
import { Service } from '../../services/entities/service.entity';
import { Appointment } from '../../appointments/entities/appointment.entity';

@ObjectType()
@Entity('service_ratings')
@Unique(['appointmentId'])
export class ServiceRating {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => Int)
  @Column('int')
  rating: number;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  comment: string;

  @Field(() => [String], { nullable: true })
  @Column('jsonb', { nullable: true })
  photoUrls: string[];

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => AppUser)
  @ManyToOne(() => AppUser)
  @JoinColumn({ name: 'customerId' })
  customer: AppUser;

  @Column()
  customerId: string;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Store)
  @ManyToOne(() => Store)
  @JoinColumn({ name: 'storeId' })
  store: Store;

  @Column()
  storeId: string;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Service)
  @ManyToOne(() => Service)
  @JoinColumn({ name: 'serviceId' })
  service: Service;

  @Column()
  serviceId: string;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => Appointment)
  @ManyToOne(() => Appointment)
  @JoinColumn({ name: 'appointmentId' })
  appointment: Appointment;

  @Column()
  appointmentId: string;

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
