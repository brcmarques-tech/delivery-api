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
import { UserRole } from '../../common/enums';
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
  @Column({ unique: true })
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
