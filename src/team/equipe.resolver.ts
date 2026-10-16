import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { EquipeService } from './equipe.service';
import {
  VendorTeamMember,
  ModuloDaLoja,
  PapelNaEquipe,
} from './entities/vendor-team-member.entity';

/**
 * KAN-82. Tudo aqui é do painel do lojista, com uma exceção marcada: a
 * listagem para o superadmin.
 *
 * Nenhuma operação recebe "quem sou eu" por argumento — vem do token
 * (@CurrentUser). Uma mutation de equipe que aceitasse o id do ator seria
 * exatamente o furo que a feature inteira existe para fechar.
 */
@Resolver(() => VendorTeamMember)
export class EquipeResolver {
  constructor(private readonly equipe: EquipeService) {}

  @Query(() => [VendorTeamMember])
  @UseGuards(GqlAuthGuard)
  equipeDaLoja(
    @Args('storeId') storeId: string,
    @CurrentUser() user: any,
  ): Promise<VendorTeamMember[]> {
    return this.equipe.listar(user.id, storeId);
  }

  /** As lojas em que EU sou membro (não dono) — o painel monta o menu com isto. */
  @Query(() => [VendorTeamMember])
  @UseGuards(GqlAuthGuard)
  minhasEquipes(@CurrentUser() user: any): Promise<VendorTeamMember[]> {
    return this.equipe.minhasLojasComoMembro(user.id);
  }

  @Mutation(() => VendorTeamMember)
  @UseGuards(GqlAuthGuard)
  convidarMembro(
    @Args('storeId') storeId: string,
    @Args('email') email: string,
    @Args('role', { type: () => PapelNaEquipe }) role: PapelNaEquipe,
    @Args('permissions', { type: () => [ModuloDaLoja] }) permissions: ModuloDaLoja[],
    @CurrentUser() user: any,
  ): Promise<VendorTeamMember> {
    return this.equipe.convidar(user.id, storeId, email, role, permissions);
  }

  @Mutation(() => VendorTeamMember)
  @UseGuards(GqlAuthGuard)
  aceitarConviteDeEquipe(
    @Args('token') token: string,
    @CurrentUser() user: any,
  ): Promise<VendorTeamMember> {
    return this.equipe.aceitar(user.id, token);
  }

  @Mutation(() => VendorTeamMember)
  @UseGuards(GqlAuthGuard)
  atualizarMembroDaEquipe(
    @Args('membroId', { type: () => ID }) membroId: string,
    @Args('permissions', { type: () => [ModuloDaLoja] }) permissions: ModuloDaLoja[],
    @Args('role', { type: () => PapelNaEquipe, nullable: true }) role: PapelNaEquipe | undefined,
    @CurrentUser() user: any,
  ): Promise<VendorTeamMember> {
    return this.equipe.atualizarPermissoes(user.id, membroId, permissions, role);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  revogarMembroDaEquipe(
    @Args('membroId', { type: () => ID }) membroId: string,
    @CurrentUser() user: any,
  ): Promise<boolean> {
    return this.equipe.revogar(user.id, membroId);
  }

  /** Superadmin: ver a equipe de qualquer loja (suporte e auditoria). */
  @Query(() => [VendorTeamMember])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  equipeDaLojaAdmin(@Args('storeId') storeId: string): Promise<VendorTeamMember[]> {
    return this.equipe.listarParaSuperadmin(storeId);
  }
}
