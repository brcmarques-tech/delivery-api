import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards, ForbiddenException } from '@nestjs/common';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ContaService } from './conta.service';

/** KAN-326 / LGPD: o titular (cliente ou entregador) exclui a própria conta. */
@Resolver()
export class ContaResolver {
  constructor(private readonly contaService: ContaService) {}

  /** O que impede excluir a conta agora (vazio = pode). O app mostra antes de pedir a senha. */
  @Query(() => [String])
  @UseGuards(GqlAuthGuard)
  impedimentosParaExcluirConta(@CurrentUser() user: any): Promise<string[]> {
    if (user.userType === 'vendor') throw new ForbiddenException('Conta de lojista: fale com o suporte.');
    return this.contaService.impedimentos(user.id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  excluirMinhaConta(
    @CurrentUser() user: any,
    @Args('senha', { nullable: true }) senha?: string,
    // conta criada pelo Google (sem senha): digitar EXCLUIR
    @Args('confirmacao', { nullable: true }) confirmacao?: string,
  ): Promise<boolean> {
    if (user.userType === 'vendor') throw new ForbiddenException('Conta de lojista: fale com o suporte.');
    return this.contaService.excluirMinhaConta(user.id, senha, confirmacao);
  }
}
