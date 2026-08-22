import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { UserRole } from '../../common/enums';
import { Order } from '../../orders/entities/order.entity';
import { Address } from '../../addresses/entities/address.entity';

@ObjectType()
@Entity('app_users')
export class AppUser {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field()
  @Column({ unique: true })
  email: string;

  @Column({ nullable: true })
  password: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  googleId: string;

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

  // PII#1-3: cpf sai do @Field direto e passa a ser resolvido com gate (só o
  // próprio dono ou superadmin recebem). Antes qualquer parte de um pedido
  // (entregador via availableDeliveries, vendedor via storeOrders, cliente via
  // order.delivery.deliverer) colhia o CPF alheio. A coluna continua.
  // Indice unico parcial (KAN-280): a unicidade de CPF era só um findOne antes
  // do save — TOCTOU puro, e furavel por mascara ("111.444.777-35" vs
  // "11144477735"). O create normaliza; o indice fecha a corrida.
  @Index('UQ_app_users_cpf', { unique: true, where: `"cpf" IS NOT NULL` })
  @Column({ nullable: true })
  cpf: string;

  // Campos de entregador
  @Field({ nullable: true })
  @Column({ nullable: true })
  vehicleType: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  vehiclePlate: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  profilePhotoUrl: string;

  // PII#2: dossiê de identidade do entregador (fotos de documento, CNH, data de
  // nascimento) — só o próprio ou superadmin. Antes o cliente lia tudo via
  // order.delivery.deliverer.
  @Column({ nullable: true })
  identityPhotoUrl: string;

  @Column({ nullable: true })
  identityPhotoBackUrl: string;

  @Column({ nullable: true })
  birthDate: string;

  @Column({ nullable: true })
  cnhNumber: string;

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

  // Verificação de contato
  @Field()
  @Column({ default: false })
  emailVerified: boolean;

  @Field()
  @Column({ default: false })
  phoneVerified: boolean;

  // Termos de uso aceitos
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  acceptedTermsAt: Date | null;

  // Session token for single-session enforcement
  @Column({ nullable: true })
  sessionToken: string;

  // KAN-280: presenca de sessao SEPARADA da rotacao. O sessionToken rotaciona
  // (nunca volta a null) para invalidar JWTs no logout/reset — mas o detector
  // de "sessao ativa" era `sessionToken != null`, permanentemente truthy apos o
  // primeiro login: reset de senha ou logout limpo seguido de login legitimo
  // devolvia ACTIVE_SESSION de um aparelho que nao existe.
  @Column({ default: false })
  sessionActive: boolean;

  // Push notifications
  @Column({ nullable: true })
  expoPushToken: string;

  // Pagar.me recipient ID (for deliverer split payments)
  // PII#4: sem @Field (mesma correção do KAN-259 no VendorUser). É um handle
  // interno de conta de repasse; consumidores usam `paymentConnected`. Antes
  // vazava para qualquer parte de um pedido.
  @Column({ nullable: true })
  pagarmeRecipientId: string;

  // Pagar.me customer ID (for saved cards)
  @Column({ nullable: true })
  pagarmeCustomerId: string;

  // Payment provider connected status (DB column kept as mpConnected for migration compat)
  @Field()
  @Column({ name: 'mpConnected', default: false })
  paymentConnected: boolean;

  @Field(() => [Order], { nullable: true })
  @OneToMany(() => Order, (order) => order.customer)
  orders: Order[];

  @Field(() => [Address], { nullable: true })
  @OneToMany(() => Address, (address) => address.user)
  addresses: Address[];

  @Column({ nullable: true })
  resetPasswordToken: string;

  @Column({ nullable: true, type: 'timestamp' })
  resetPasswordExpires: Date;

  // Permissoes do superadmin (null = todas as permissoes)
  //
  // A coluna e jsonb, entao o TypeORM devolve um OBJETO — mas o campo GraphQL e
  // String. Ao pedir `permissions` numa query, o scalar String nao conseguia
  // serializar o objeto e a query inteira falhava com "String cannot represent
  // value". Por isso o campo nunca foi pedido pelo painel, e o sistema de
  // permissoes granulares ficou inteiro sem efeito. O @ResolveField no
  // AppUsersResolver serializa antes de devolver.
  @Field(() => String, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  permissions: string | null;

  // Email de notificacao do superadmin (diferente do email de login)
  @Field({ nullable: true })
  @Column({ nullable: true })
  notificationEmail: string;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
