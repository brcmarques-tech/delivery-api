import { Resolver, Query, ObjectType, Field, Int, Float } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AppUser } from '../users/entities/app-user.entity';
import { Coupon } from '../coupons/entities/coupon.entity';
import { FidelidadeService } from './fidelidade.service';

@ObjectType()
export class FidelidadeNaLoja {
  @Field() storeId: string;
  @Field() storeName: string;
  @Field({ nullable: true }) storeLogoUrl?: string;
  @Field(() => Int) comprasConcluidas: number;
  @Field(() => Int) comprasNoMes: number;
  @Field(() => Int) faltamParaOProximoPremio: number;
  @Field() proximoMarco: string;
  @Field() clienteFiel: boolean;
}

@ObjectType()
export class MinhaFidelidade {
  @Field(() => [FidelidadeNaLoja]) porLoja: FidelidadeNaLoja[];
  @Field(() => [Coupon]) cupons: Coupon[];
  /** Em quantas lojas o cliente já é considerado fiel. */
  @Field(() => Int) lojasOndeSouFiel: number;
  @Field(() => Int) comprasNoTotal: number;
  @Field(() => Float) descontoDisponivel: number;
}

/**
 * KAN-12. A tela de fidelidade do app sai daqui.
 *
 * Tudo é do PRÓPRIO cliente (@CurrentUser) — não existe argumento de usuário,
 * de propósito: query de fidelidade que aceita um id de cliente é um convite a
 * olhar o histórico de compra alheio.
 */
@Resolver()
export class FidelidadeResolver {
  constructor(private readonly fidelidade: FidelidadeService) {}

  @Query(() => MinhaFidelidade)
  @UseGuards(GqlAuthGuard)
  async minhaFidelidade(@CurrentUser() user: AppUser): Promise<MinhaFidelidade> {
    const [porLoja, cupons] = await Promise.all([
      this.fidelidade.progressoDoCliente(user.id),
      this.fidelidade.cuponsDoCliente(user.id),
    ]);

    const agora = new Date();
    const valendo = cupons.filter(
      (c) =>
        c.isActive &&
        (c.maxUses === 0 || c.usesCount < c.maxUses) &&
        (!c.expiresAt || new Date(c.expiresAt) > agora),
    );

    return {
      porLoja: porLoja.map((p) => ({ ...p, storeLogoUrl: p.storeLogoUrl ?? undefined })),
      cupons,
      lojasOndeSouFiel: porLoja.filter((p) => p.clienteFiel).length,
      comprasNoTotal: porLoja.reduce((s, p) => s + p.comprasConcluidas, 0),
      // Soma dos percentuais dos cupons VÁLIDOS. É um número de vitrine ("você
      // tem 25% em descontos esperando"), não um valor em reais: o desconto só
      // vira dinheiro quando aplicado a um pedido.
      descontoDisponivel: valendo.reduce((s, c) => s + Number(c.discountValue || 0), 0),
    };
  }
}
