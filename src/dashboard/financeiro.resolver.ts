import { Resolver, Query, Args, Int, ObjectType, Field, Float } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { Order } from '../orders/entities/order.entity';

@ObjectType()
export class ResumoFinanceiro {
  @Field(() => Int) pedidosPagos: number;
  @Field(() => Float) volumeVendido: number;
  @Field(() => Float) comissaoDaPlataforma: number;
  @Field(() => Float) freteTotal: number;
  @Field(() => Float) freteDaPlataforma: number;
  @Field(() => Float) parteDosVendedores: number;
  @Field(() => Float) emCustodia: number;
}

@ObjectType()
export class RepassePorStatus {
  @Field(() => Int) vendedoresLiquidados: number;
  @Field(() => Int) vendedoresPendentes: number;
  @Field(() => Int) entregadoresLiquidados: number;
  @Field(() => Float) passivoDeVendedores: number;
  @Field(() => Float) passivoDeEntregadores: number;
  @Field(() => Float) passivoJaPago: number;
}

@ObjectType()
export class LinhaDeLoja {
  @Field() storeId: string;
  @Field() storeName: string;
  @Field(() => Int) pedidos: number;
  @Field(() => Float) volume: number;
  @Field(() => Float) comissao: number;
  @Field(() => Float) parteDaLoja: number;
  @Field(() => Float) aReceber: number;
  @Field(() => Float) percentualMedioDeComissao: number;
}

@ObjectType()
export class DiaFinanceiro {
  @Field() dia: string;
  @Field(() => Float) volume: number;
  @Field(() => Float) comissao: number;
}

@ObjectType()
export class PainelFinanceiro {
  @Field(() => Int) periodoDias: number;
  @Field(() => ResumoFinanceiro) resumo: ResumoFinanceiro;
  @Field(() => RepassePorStatus) repasses: RepassePorStatus;
  @Field(() => [LinhaDeLoja]) porLoja: LinhaDeLoja[];
  @Field(() => [DiaFinanceiro]) porDia: DiaFinanceiro[];
}

/**
 * KAN-102 — O PAINEL DO DINHEIRO
 *
 * O superadmin tinha volume e "platformRevenue" soltos no painel geral, e uma
 * tela de repasses retidos. Faltava a visão que responde as perguntas de
 * dono: quanto entrou, quanto é da plataforma, quanto é de cada loja, quanto
 * ainda está em custódia e quanto está PARADO porque o repasse não saiu.
 *
 * REGRA QUE VALE PARA TUDO AQUI: a aritmética é a MESMA de
 * `PaymentsService.settlePayment` e `OrdersService.createOrder`. Repetir
 * fórmula de dinheiro em SQL é como as duas cópias da haversine do frete
 * (KAN-29) — divergem na primeira vez que alguém mexe numa. Então cada conta
 * abaixo diz de onde veio:
 *
 *   comissão ....... `orders.commissionAmount`, gravado na criação do pedido
 *                    (percentual do plano sobre subtotal - desconto)
 *   frete .......... `orders.deliveryFee`
 *   frete é da ..... plataforma quando a entrega é por entregador do app
 *   plataforma?      (store.hasOwnDelivery = false E isPickup = false);
 *                    senão a loja fica com ele
 *   vendedor ....... total - comissão - frete-da-plataforma
 *   custódia ....... pedido PAGO e ainda não liquidado (isSettled = false)
 *
 * "PEDIDO PAGO" aqui exclui AWAITING_PAYMENT (nunca pagou) e os terminais de
 * cancelamento. Incluir qualquer um deles infla o faturamento com dinheiro
 * que não existe — e um painel financeiro que exagera é pior que nenhum.
 */
@Resolver()
export class FinanceiroResolver {
  constructor(
    @InjectRepository(Order)
    private readonly ordersRepository: Repository<Order>,
  ) {}

  /**
   * Trecho SQL compartilhado: o que conta como pedido pago no período.
   * Em um lugar só, para as quatro consultas abaixo não divergirem entre si.
   */
  private static readonly PAGOS = `
    o.status NOT IN ('AWAITING_PAYMENT','PAYMENT_REVIEW','CANCELLED','REJECTED','EXPIRED')
    AND o."createdAt" >= NOW() - ($1 || ' days')::interval
  `;

  /** Frete que fica com a PLATAFORMA (entrega por entregador do app). */
  private static readonly FRETE_PLATAFORMA = `
    CASE WHEN s."hasOwnDelivery" = false AND o."isPickup" = false
         THEN COALESCE(o."deliveryFee", 0) ELSE 0 END
  `;

  @Query(() => PainelFinanceiro)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async painelFinanceiro(
    @Args('dias', { type: () => Int, nullable: true, defaultValue: 30 }) dias?: number,
  ): Promise<PainelFinanceiro> {
    // Teto de 365 dias: o painel varre a tabela de pedidos, e um período
    // aberto viraria scan completo a cada abertura de tela.
    const periodoDias = Math.min(Math.max(Number(dias) || 30, 1), 365);
    const p = [String(periodoDias)];

    const [resumoRaw] = await this.ordersRepository.manager.query(
      `SELECT
         COUNT(*)::int                                            AS "pedidosPagos",
         COALESCE(SUM(o.total), 0)                                AS "volumeVendido",
         COALESCE(SUM(o."commissionAmount"), 0)                   AS "comissaoDaPlataforma",
         COALESCE(SUM(o."deliveryFee"), 0)                        AS "freteTotal",
         COALESCE(SUM(${FinanceiroResolver.FRETE_PLATAFORMA}), 0) AS "freteDaPlataforma",
         COALESCE(SUM(
           o.total - COALESCE(o."commissionAmount", 0) - ${FinanceiroResolver.FRETE_PLATAFORMA}
         ), 0)                                                    AS "parteDosVendedores",
         COALESCE(SUM(CASE WHEN o."isSettled" = false THEN o.total ELSE 0 END), 0) AS "emCustodia"
       FROM orders o
       JOIN stores s ON s.id = o."storeId"
       WHERE ${FinanceiroResolver.PAGOS}`,
      p,
    );

    const [repassesRaw] = await this.ordersRepository.manager.query(
      `SELECT
         COUNT(*) FILTER (WHERE o."vendorSettledAt" IS NOT NULL OR o."settledViaSplit" = true)::int AS "vendedoresLiquidados",
         COUNT(*) FILTER (WHERE o."vendorSettledAt" IS NULL AND COALESCE(o."settledViaSplit", false) = false)::int AS "vendedoresPendentes",
         COUNT(*) FILTER (WHERE o."delivererSettledAt" IS NOT NULL)::int AS "entregadoresLiquidados",
         -- Passivo = dinheiro que a plataforma DEVE e ainda não pagou. Os
         -- centavos vêm das colunas que o settle grava quando o repasse é
         -- recusado pelo gateway (allowlist de IP, KAN-299/300).
         COALESCE(SUM(CASE WHEN o."vendorPayablePaidAt" IS NULL THEN COALESCE(o."vendorPayableCents", 0) ELSE 0 END), 0) / 100.0 AS "passivoDeVendedores",
         COALESCE(SUM(CASE WHEN o."delivererPayablePaidAt" IS NULL THEN COALESCE(o."delivererPayableCents", 0) ELSE 0 END), 0) / 100.0 AS "passivoDeEntregadores",
         COALESCE(SUM(
           CASE WHEN o."vendorPayablePaidAt" IS NOT NULL THEN COALESCE(o."vendorPayableCents", 0) ELSE 0 END +
           CASE WHEN o."delivererPayablePaidAt" IS NOT NULL THEN COALESCE(o."delivererPayableCents", 0) ELSE 0 END
         ), 0) / 100.0 AS "passivoJaPago"
       FROM orders o
       JOIN stores s ON s.id = o."storeId"
       WHERE ${FinanceiroResolver.PAGOS}`,
      p,
    );

    const porLoja = await this.ordersRepository.manager.query(
      `SELECT
         s.id                                   AS "storeId",
         s.name                                 AS "storeName",
         COUNT(*)::int                          AS pedidos,
         COALESCE(SUM(o.total), 0)              AS volume,
         COALESCE(SUM(o."commissionAmount"), 0) AS comissao,
         COALESCE(SUM(
           o.total - COALESCE(o."commissionAmount", 0) - ${FinanceiroResolver.FRETE_PLATAFORMA}
         ), 0)                                  AS "parteDaLoja",
         -- A RECEBER: o que a loja ainda não recebeu. Pedido liquidado (ou
         -- pago via split do PIX) já caiu na conta dela.
         COALESCE(SUM(
           CASE WHEN o."vendorSettledAt" IS NULL AND COALESCE(o."settledViaSplit", false) = false
                THEN o.total - COALESCE(o."commissionAmount", 0) - ${FinanceiroResolver.FRETE_PLATAFORMA}
                ELSE 0 END
         ), 0)                                  AS "aReceber",
         -- Percentual MÉDIO cobrado: é o número que denuncia loja no plano
         -- errado (PRO pagando 5% de FREE, PREMIUM pagando qualquer coisa).
         CASE WHEN SUM(o.subtotal - COALESCE(o.discount, 0)) > 0
              THEN ROUND(100 * SUM(COALESCE(o."commissionAmount", 0)) / SUM(o.subtotal - COALESCE(o.discount, 0)), 2)
              ELSE 0 END                        AS "percentualMedioDeComissao"
       FROM orders o
       JOIN stores s ON s.id = o."storeId"
       WHERE ${FinanceiroResolver.PAGOS}
       GROUP BY s.id, s.name
       ORDER BY volume DESC
       LIMIT 50`,
      p,
    );

    const porDia = await this.ordersRepository.manager.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('day', o."createdAt"), 'YYYY-MM-DD') AS dia,
         COALESCE(SUM(o.total), 0)                               AS volume,
         COALESCE(SUM(o."commissionAmount"), 0)                  AS comissao
       FROM orders o
       JOIN stores s ON s.id = o."storeId"
       WHERE ${FinanceiroResolver.PAGOS}
       GROUP BY 1
       ORDER BY 1`,
      p,
    );

    const n = (v: any) => Number(v) || 0;
    return {
      periodoDias,
      resumo: {
        pedidosPagos: n(resumoRaw?.pedidosPagos),
        volumeVendido: n(resumoRaw?.volumeVendido),
        comissaoDaPlataforma: n(resumoRaw?.comissaoDaPlataforma),
        freteTotal: n(resumoRaw?.freteTotal),
        freteDaPlataforma: n(resumoRaw?.freteDaPlataforma),
        parteDosVendedores: n(resumoRaw?.parteDosVendedores),
        emCustodia: n(resumoRaw?.emCustodia),
      },
      repasses: {
        vendedoresLiquidados: n(repassesRaw?.vendedoresLiquidados),
        vendedoresPendentes: n(repassesRaw?.vendedoresPendentes),
        entregadoresLiquidados: n(repassesRaw?.entregadoresLiquidados),
        passivoDeVendedores: n(repassesRaw?.passivoDeVendedores),
        passivoDeEntregadores: n(repassesRaw?.passivoDeEntregadores),
        passivoJaPago: n(repassesRaw?.passivoJaPago),
      },
      porLoja: (porLoja || []).map((l: any) => ({
        storeId: l.storeId,
        storeName: l.storeName,
        pedidos: n(l.pedidos),
        volume: n(l.volume),
        comissao: n(l.comissao),
        parteDaLoja: n(l.parteDaLoja),
        aReceber: n(l.aReceber),
        percentualMedioDeComissao: n(l.percentualMedioDeComissao),
      })),
      porDia: (porDia || []).map((d: any) => ({
        dia: d.dia,
        volume: n(d.volume),
        comissao: n(d.comissao),
      })),
    };
  }
}
