import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { AppUser } from '../../users/entities/app-user.entity';

@ObjectType()
@Entity('addresses')
export class Address {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  street: string;

  @Field()
  @Column()
  number: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  complement: string;

  @Field()
  @Column()
  neighborhood: string;

  @Field()
  @Column()
  city: string;

  @Field()
  @Column()
  state: string;

  @Field()
  @Column()
  zipCode: string;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 7 })
  latitude: number;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 7 })
  longitude: number;

  @Field()
  @Column({ default: false })
  isDefault: boolean;

  @Index() // KAN-261: FK sem indice fazia scan da tabela inteira
  @Field(() => AppUser)
  @ManyToOne(() => AppUser, (user) => user.addresses)
  user: AppUser;

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
