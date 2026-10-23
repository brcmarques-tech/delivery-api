import { Args, Field, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permission } from '../auth/decorators/permission.decorator';
import { UserRole } from '../common/enums';
import { AppUser } from '../users/entities/app-user.entity';
import { RepasseEntregador } from './entities/repasse-entregador.entity';
import { RepassesEntregadorService } from './repasses-entregador.service';

@ObjectType()
class FreteAReceber {
  @Field() orderNumber: string;
  @Field() loja: string;
  @Field(() => Int) cents: number;
  @Field() concluidoEm: Date;
  @Field() pagamentoPrevisto: Date;
}

@ObjectType()
class SaldoDeEntregas {
  @Field(() => Int) aReceberCents: number;
  @Field({ nullable: true }) proximoPagamento?: Date;
  @Field(() => Int) proximoPagamentoCents: number;
  @Field(() => [FreteAReceber]) entregas: FreteAReceber[];
  @Field(() => [RepasseEntregador]) pagos: RepasseEntregador[];
  @Field({ nullable: true }) chavePix?: string;
}

@ObjectType()
class EntregadorNoFechamento {
  @Field() delivererId: string;
  @Field() nome: string;
  @Field({ nullable: true }) telefone?: string;
  @Field({ nullable: true }) chavePix?: string;
  @Field(() => Int) devidoCents: number;
  @Field(() => Int) devidoQuantidade: number;
  @Field(() => Int) proximoCicloCents: number;
  @Field(() => [String]) pedidos: string[];
}

@ObjectType()
class FechamentoDeRepasses {
  @Field() corte: Date;
  @Field() dataDePagamento: Date;
  @Field(() => Int) totalDevidoCents: number;
  @Field(() => Int) totalProximoCicloCents: number;
  @Field(() => [EntregadorNoFechamento]) entregadores: EntregadorNoFechamento[];
}

/** Repasse semanal ao entregador — ver RepassesEntregadorService. */
@Resolver()
export class RepassesEntregadorResolver {
  constructor(private service: RepassesEntregadorService) {}

  @Query(() => SaldoDeEntregas)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  meuSaldoDeEntregas(@CurrentUser() user: AppUser) {
    return this.service.saldoDoEntregador(user.id);
  }

  @Mutation(() => String)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.DELIVERER)
  salvarChavePix(@CurrentUser() user: AppUser, @Args('chave') chave: string) {
    return this.service.salvarChavePix(user.id, chave);
  }

  @Query(() => FechamentoDeRepasses)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('deliveries')
  fechamentoDeRepasses() {
    return this.service.fechamento();
  }

  @Mutation(() => RepasseEntregador)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('deliveries')
  registrarRepasseDoEntregador(
    @CurrentUser() user: AppUser,
    @Args('delivererId') delivererId: string,
    @Args('observacao', { nullable: true }) observacao?: string,
  ) {
    return this.service.registrarPagamento(delivererId, user.id, observacao);
  }

  @Query(() => [RepasseEntregador])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('deliveries')
  historicoDeRepasses(@Args('limit', { type: () => Int, nullable: true, defaultValue: 50 }) limit: number) {
    return this.service.historico(limit);
  }
}
