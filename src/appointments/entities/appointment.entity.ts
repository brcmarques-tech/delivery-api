import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { AppUser } from '../../users/entities/app-user.entity';
import { Store } from '../../stores/entities/store.entity';
import { Service } from '../../services/entities/service.entity';
import { AppointmentStatus } from '../../common/enums/appointment-status.enum';

@ObjectType()
@Entity('appointments')
export class Appointment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  appointmentNumber: string;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => AppUser)
  @ManyToOne(() => AppUser, { eager: false })
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

  @Field()
  @Column()
  scheduledDate: string;

  @Field()
  @Column()
  scheduledTime: string;

  @Field()
  @Column()
  endTime: string;

  @Field(() => AppointmentStatus)
  @Column({ type: 'enum', enum: AppointmentStatus, default: AppointmentStatus.PENDING })
  status: AppointmentStatus;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  price: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  notes: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  address: string;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  latitude: number;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  longitude: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  paymentMethod: string;

  @Field({ nullable: true })
  @Column({ nullable: true, default: 'PENDING' })
  paymentStatus: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  checkoutUrl: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  pagarmeOrderId: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  pixQrCode: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  pixQrCodeBase64: string;

  @Column({ nullable: true })
  preAuthChargeId: string;

  @Column({ nullable: true })
  capturedAt: Date;

  @Column({ default: false })
  isSettled: boolean;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  commissionAmount: number;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  quoteDescription: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  quoteResponse: string;

  // Internal only — not exposed via GraphQL
  @Column({ default: false })
  reminderSent: boolean;

  // Soft delete — not exposed via GraphQL
  @Column({ nullable: true })
  deletedAt: Date;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
