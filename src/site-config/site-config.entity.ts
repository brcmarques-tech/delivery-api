import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';
import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
@Entity('site_config')
export class SiteConfig {
  @Field()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ unique: true })
  key: string;

  @Field()
  @Column({ type: 'text', default: '' })
  value: string;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
