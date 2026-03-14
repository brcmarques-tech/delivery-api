import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { UserRole } from '../../common/enums';
import { Order } from '../../orders/entities/order.entity';
import { Address } from '../../addresses/entities/address.entity';

@ObjectType()
@Entity('app_users')
export class AppUser {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field()
  @Column({ unique: true })
  email: string;

  @Column()
  password: string;

  @Field()
  @Column()
  phone: string;

  @Field(() => UserRole)
  @Column({ type: 'enum', enum: UserRole, default: UserRole.CUSTOMER })
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

  // Campos de entregador
  @Field({ nullable: true })
  @Column({ nullable: true })
  vehicleType: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  vehiclePlate: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  profilePhotoUrl: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  identityPhotoUrl: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  birthDate: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  cnhNumber: string;

  @Field()
  @Column({ default: false })
  isDeliverer: boolean;

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

  // Termos de uso aceitos
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  acceptedTermsAt: Date | null;

  // Push notifications
  @Column({ nullable: true })
  expoPushToken: string;

  // Mercado Pago customer ID para cartoes salvos
  @Column({ nullable: true })
  mpCustomerId: string;

  // Mercado Pago para entregador
  @Field()
  @Column({ default: false })
  mpConnected: boolean;

  @Column({ nullable: true })
  mpAccessToken: string;

  @Column({ nullable: true })
  mpRefreshToken: string;

  @Column({ nullable: true })
  mpUserId: string;

  @Field(() => [Order], { nullable: true })
  @OneToMany(() => Order, (order) => order.customer)
  orders: Order[];

  @Field(() => [Address], { nullable: true })
  @OneToMany(() => Address, (address) => address.user)
  addresses: Address[];

  @Column({ nullable: true })
  resetPasswordToken: string;

  @Column({ nullable: true, type: 'timestamp' })
  resetPasswordExpires: Date;

  // Permissoes do superadmin (null = todas as permissoes)
  @Field(() => String, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  permissions: string | null;

  // Email de notificacao do superadmin (diferente do email de login)
  @Field({ nullable: true })
  @Column({ nullable: true })
  notificationEmail: string;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
