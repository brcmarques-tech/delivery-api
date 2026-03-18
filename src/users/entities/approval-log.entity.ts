import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
@Entity()
export class ApprovalLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  userId: string;

  @Field()
  @Column()
  userName: string;

  @Field()
  @Column()
  userEmail: string;

  @Field()
  @Column({ comment: 'app or vendor' })
  userType: string;

  @Field()
  @Column({ comment: 'APPROVED or REJECTED' })
  action: string;

  @Field()
  @Column({ comment: 'Role being approved/rejected (DELIVERER, VENDOR, etc)' })
  role: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  reason: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  adminId: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  profilePhotoUrl: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  identityPhotoUrl: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  identityPhotoBackUrl: string | null;

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
