import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  OneToOne,
} from 'typeorm';
import { UserRole, VendorPlan } from '../../common/enums';
import { Store } from '../../stores/entities/store.entity';
import { Order } from '../../orders/entities/order.entity';
import { Address } from '../../addresses/entities/address.entity';

@ObjectType()
@Entity('users')
export class User {
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

  // Campos de entregador
  @Field({ nullable: true })
  @Column({ nullable: true })
  cpf: string;

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

  // Plano do vendedor
  @Field(() => VendorPlan, { nullable: true })
  @Column({ type: 'enum', enum: VendorPlan, nullable: true })
  vendorPlan: VendorPlan | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  planExpiresAt: Date | null;

  @Field(() => [Store], { nullable: true })
  @OneToMany(() => Store, (store) => store.owner)
  stores: Store[];

  @Field(() => [Order], { nullable: true })
  @OneToMany(() => Order, (order) => order.customer)
  orders: Order[];

  @Field(() => [Address], { nullable: true })
  @OneToMany(() => Address, (address) => address.user)
  addresses: Address[];

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
