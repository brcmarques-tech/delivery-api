import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';

@ObjectType()
@Entity('platform_config')
export class PlatformConfig {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ unique: true })
  key: string;

  @Field()
  @Column()
  value: string;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
