import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Um pagamento semanal (quarta) feito a um entregador: o lote de fretes retidos
 * que foi pago de uma vez. Cada pedido pago aponta para cá por
 * `orders.delivererPayoutId` — é o que permite mostrar ao entregador "o que
 * entrou em cada quarta" e ao superadmin o histórico.
 */
@ObjectType()
@Entity('repasses_entregador')
export class RepasseEntregador {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Index()
  @Column('uuid')
  delivererId: string;

  @Field(() => Int)
  @Column('int')
  totalCents: number;

  @Field(() => Int)
  @Column('int')
  quantidade: number;

  /** Corte usado: entraram as entregas concluídas antes deste instante. */
  @Field()
  @Column({ type: 'timestamp' })
  corte: Date;

  /** Chave PIX usada no pagamento (cópia: a do cadastro pode mudar depois). */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  chavePix: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  observacao: string | null;

  /** Superadmin que registrou o pagamento. */
  @Column({ type: 'uuid', nullable: true })
  pagoPor: string | null;

  @Field()
  @CreateDateColumn()
  pagoEm: Date;

  /** Nome do entregador, preenchido no histórico (não é coluna). */
  @Field(() => String, { nullable: true })
  delivererNome?: string | null;
}
