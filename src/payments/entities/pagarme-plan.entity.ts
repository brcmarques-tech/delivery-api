import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { VendorPlan } from '../../common/enums';

@Entity('pagarme_plans')
export class PagarmePlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ unique: true })
  pagarmePlanId: string;

  @Column({ type: 'enum', enum: VendorPlan })
  vendorPlan: VendorPlan;

  @Column()
  billingPeriod: string; // 'monthly' | 'quarterly' | 'semiannual' | 'annual'

  @Column()
  intervalCount: number; // 1, 3, 6, 12

  @Column()
  priceInCents: number;

  @Column({ default: 1 })
  installments: number;

  @CreateDateColumn()
  createdAt: Date;
}
