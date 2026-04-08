import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum AgentSessionStatus {
  ACTIVE = 'ACTIVE',
  AWAITING_CONFIRM = 'AWAITING_CONFIRM',
  BLOCKED = 'BLOCKED',
}

export interface ConversationMessage {
  role: 'user' | 'model';
  content: string;
  timestamp: string;
}

@Entity('agent_sessions')
export class AgentSession {
  @PrimaryColumn()
  phoneNumber: string;

  @Column({ nullable: true })
  storeId: string;

  @Column({ nullable: true })
  role: string; // 'vendor' | 'customer'

  @Column({ type: 'jsonb', default: [] })
  conversationHistory: ConversationMessage[];

  @Column({
    type: 'enum',
    enum: AgentSessionStatus,
    default: AgentSessionStatus.ACTIVE,
  })
  status: AgentSessionStatus;

  @Column({ type: 'jsonb', nullable: true })
  pendingOrderData: any;

  @Column({ nullable: true })
  lastMessageAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
