import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
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

  // Repasse de LOJISTA retido na plataforma, igual ao de `orders`.
  //
  // Mesma origem: bloqueio de origem do Pagar.me (allowlist de IP, KAN-299).
  // A transferência FOI tentada e o provedor recusou por configuração NOSSA,
  // então re-tentar não resolve. Sem isto, o retry de 48h gastava as 48h
  // contra um 401 que nunca muda, avisava o lojista a cada rodada sobre um
  // problema que não é dele, e no fim o dinheiro ficava com a plataforma sem
  // registro nenhum.
  //
  // `isSettled` continua FALSE nesses casos: o lojista não recebeu, e marcar
  // como liquidado esconderia a dívida. O que muda é o valor passar a ter onde
  // ser somado e baixado.
  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  vendorPayableCents: number;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  vendorPayablePaidAt: Date;

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
