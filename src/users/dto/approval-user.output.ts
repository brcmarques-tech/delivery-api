import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

/**
 * KAN-245: DTO achatado para o historico de aprovacoes/rejeicoes no painel.
 *
 * Antes o painel puxava `allAppUsers` + `allVendorUsers` (a base INTEIRA das
 * duas tabelas, com fotos de documento) e filtrava/ordenava por approvedAt/
 * rejectedAt no cliente. Agora o servidor faz o filtro, a busca, a ordenacao e
 * a paginacao (UNION das duas tabelas) e devolve so a pagina pedida.
 *
 * A query e superadmin-only (mesmo guard do allAppUsers), por isso os campos de
 * documento saem direto aqui — o gate de PII do AppUser ja liberava tudo para o
 * superadmin.
 */
@ObjectType()
export class ApprovalUser {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  email: string;

  @Field()
  phone: string;

  @Field()
  role: string;

  @Field(() => String, { nullable: true })
  pendingRole: string | null;

  @Field(() => String, { nullable: true })
  cpf: string | null;

  @Field(() => String, { nullable: true })
  vehicleType: string | null;

  @Field(() => String, { nullable: true })
  vehiclePlate: string | null;

  @Field(() => String, { nullable: true })
  profilePhotoUrl: string | null;

  @Field(() => String, { nullable: true })
  identityPhotoUrl: string | null;

  @Field(() => String, { nullable: true })
  identityPhotoBackUrl: string | null;

  @Field(() => Date, { nullable: true })
  approvedAt: Date | null;

  @Field(() => Date, { nullable: true })
  rejectedAt: Date | null;

  @Field(() => String, { nullable: true })
  rejectionReason: string | null;

  @Field()
  createdAt: Date;

  /** "app" | "vendor" */
  @Field()
  source: string;
}

@ObjectType()
export class ApprovalUserPage {
  @Field(() => [ApprovalUser])
  items: ApprovalUser[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}

@ObjectType()
export class ApprovalCounts {
  @Field(() => Int)
  approved: number;

  @Field(() => Int)
  rejected: number;
}
