import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { VendorUser } from '../../users/entities/vendor-user.entity';
import { Store } from '../../stores/entities/store.entity';

export enum PapelNaEquipe {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  EMPLOYEE = 'EMPLOYEE',
}
registerEnumType(PapelNaEquipe, { name: 'PapelNaEquipe' });

/**
 * Os módulos que podem ser liberados a um funcionário.
 *
 * É uma lista FECHADA de propósito: permissão digitada livremente vira erro de
 * digitação que concede acesso (ou que nunca concede, e ninguém entende por
 * quê). O guard compara contra estes valores.
 */
export enum ModuloDaLoja {
  ORDERS = 'ORDERS',
  PRODUCTS = 'PRODUCTS',
  PROMOTIONS = 'PROMOTIONS',
  COUPONS = 'COUPONS',
  SETTINGS = 'SETTINGS',
  EARNINGS = 'EARNINGS',
  REPORTS = 'REPORTS',
}
registerEnumType(ModuloDaLoja, { name: 'ModuloDaLoja' });

/**
 * KAN-82 — CONTAS DE EQUIPE DO LOJISTA
 *
 * Hoje a loja tem UMA conta. Na prática isso significa que o dono passa a
 * senha dele para o atendente que despacha pedidos — e junto vão os
 * recebimentos, os dados bancários e o poder de apagar produtos. A conta de
 * equipe existe para o atendente ter a própria conta, com acesso só ao que o
 * dono liberou.
 *
 * DECISÕES:
 *
 * - O convite é por E-MAIL e o membro pode nem existir ainda (`memberId` fica
 *   nulo até ele aceitar). Exigir que a pessoa já tivesse conta tornaria o
 *   convite inútil no caso mais comum: contratar alguém novo.
 *
 * - O token do convite é guardado como HASH. Um convite é um direito de
 *   acesso; com o token em texto claro, quem lesse a tabela (backup, dump,
 *   suporte) entraria na loja de qualquer cliente.
 *
 * - `revokedAt` em vez de DELETE: quem teve acesso e perdeu é informação de
 *   auditoria. Apagar a linha apaga a resposta para "quem tinha acesso quando
 *   isso aconteceu?".
 *
 * - UNIQUE (storeId, memberEmail) parcial (só entre os não revogados): o mesmo
 *   e-mail não pode ter dois convites vivos na mesma loja, mas pode ser
 *   reconvidado depois de revogado.
 */
@ObjectType()
@Unique('UQ_equipe_loja_email_vivo', ['storeId', 'memberEmail', 'revokedAt'])
@Entity('vendor_team_members')
export class VendorTeamMember {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Dono da loja que convidou. */
  @Index()
  @Field(() => VendorUser)
  @ManyToOne(() => VendorUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner: VendorUser;

  @Column()
  ownerId: string;

  @Index()
  @Field(() => Store)
  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'storeId' })
  store: Store;

  @Field()
  @Column()
  storeId: string;

  @Field()
  @Column()
  memberEmail: string;

  /** Só existe depois que a pessoa aceita o convite. */
  @Index()
  @Field(() => VendorUser, { nullable: true })
  @ManyToOne(() => VendorUser, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'memberId' })
  member: VendorUser | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  memberId: string | null;

  @Field(() => PapelNaEquipe)
  @Column({ type: 'varchar', default: PapelNaEquipe.EMPLOYEE })
  role: PapelNaEquipe;

  /**
   * Módulos liberados. Guardado como jsonb para o conjunto crescer sem
   * migration — e lido com validação contra o enum, para um valor inventado
   * não virar acesso.
   */
  @Field(() => [ModuloDaLoja])
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  permissions: ModuloDaLoja[];

  /** SHA-256 do token do convite. O token em si só existe no e-mail enviado. */
  @Column({ type: 'varchar', nullable: true })
  inviteTokenHash: string | null;

  @Field()
  @CreateDateColumn()
  invitedAt: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  acceptedAt: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
