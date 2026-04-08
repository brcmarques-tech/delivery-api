import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { UserRole, VendorPlan } from '../../common/enums';
import { Store } from '../../stores/entities/store.entity';

@ObjectType()
@Entity('vendor_users')
export class VendorUser {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field()
  @Column({ unique: true })
  email: string;

  @Column({ nullable: true })
  password: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  googleId: string;

  @Field()
  @Column()
  phone: string;

  @Field(() => UserRole)
  @Column({ type: 'enum', enum: UserRole, default: UserRole.VENDOR })
  role: UserRole;

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  avatarUrl: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  cpf: string;

  // Sistema de aprovacao
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  pendingRole: string | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  approvedAt: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  rejectedAt: Date | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  rejectionReason: string | null;

  // Verificação de contato
  @Field()
  @Column({ default: false })
  emailVerified: boolean;

  @Field()
  @Column({ default: false })
  phoneVerified: boolean;

  // Termos de uso aceitos
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  acceptedTermsAt: Date | null;

  // Contrato de assinatura aceito
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  acceptedSubscriptionTermsAt: Date | null;

  // Plano do vendedor
  @Field(() => VendorPlan, { nullable: true })
  @Column({ type: 'enum', enum: VendorPlan, nullable: true })
  vendorPlan: VendorPlan | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  planExpiresAt: Date | null;

  // Session token for single-session enforcement
  @Column({ nullable: true })
  sessionToken: string;

  // Push notifications
  @Column({ nullable: true })
  expoPushToken: string;

  // Pagar.me recipient ID (for split payments)
  @Field({ nullable: true })
  @Column({ nullable: true })
  pagarmeRecipientId: string;

  // Pagar.me subscription (recurring billing)
  @Field({ nullable: true })
  @Column({ nullable: true })
  pagarmeSubscriptionId: string;

  // Pagar.me customer ID
  @Field({ nullable: true })
  @Column({ nullable: true })
  pagarmeCustomerId: string;

  // Payment provider connected status (DB column kept as mpConnected for migration compat)
  @Field()
  @Column({ name: 'mpConnected', default: false })
  paymentConnected: boolean;

  @Field(() => [Store], { nullable: true })
  @OneToMany(() => Store, (store) => store.owner)
  stores: Store[];

  @Column({ nullable: true })
  resetPasswordToken: string;

  @Column({ nullable: true, type: 'timestamp' })
  resetPasswordExpires: Date;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
