import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Coupon } from '../coupons/entities/coupon.entity';
import { Order } from '../orders/entities/order.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { OrderStatus } from '../common/enums';

export interface ProgressoNaLoja {
  storeId: string;
  storeName: string;
  storeLogoUrl?: string | null;
  comprasConcluidas: number;
  comprasNoMes: number;
  faltamParaOProximoPremio: number;
  proximoMarco: string;
  clienteFiel: boolean;
}

/**
 * KAN-12 — CLIENTE FIEL
 *
 * A ideia do ticket: quem compra muito numa loja ganha um cupom automático, a
 * loja avisa seus clientes fiéis quando lança promoção, e o cliente vê um selo.
 *
 * ─── AS DECISÕES QUE ESTE ARQUIVO TOMA ──────────────────────────────────────
 *
 * 1. FIDELIDADE É POR LOJA, não da plataforma. Cupom no sistema pertence a uma
 *    loja (coupons.storeId é NOT NULL) e o desconto sai do bolso dela. Um
 *    prêmio "da plataforma" válido em qualquer loja seria a plataforma gastando
 *    dinheiro do lojista sem ele decidir. Então: comprou 10 vezes na padaria,
 *    ganha da padaria.
 *
 * 2. O PRÊMIO É NOMINAL. O cupom nasce amarrado ao cliente que o ganhou
 *    (coupons.appUserId) e com maxUses = 1. Sem isso, o código circula num
 *    grupo de WhatsApp e a recompensa vai para quem nunca comprou.
 *
 * 3. SÓ CONTA COMPRA QUE TERMINOU BEM. `COMPLETED` — pedido pago, entregue e
 *    confirmado. Contar pedido cancelado ou em disputa premiaria quem compra e
 *    cancela, e isso vira fraude barata: dez pedidos cancelados, um cupom.
 *
 * 4. A AVALIAÇÃO ACONTECE NA CONCLUSÃO DO PEDIDO, não num cron semanal como o
 *    ticket sugeria. O prêmio chega no momento em que a pessoa está com o app
 *    na mão e acabou de ter uma boa experiência — que é quando ele significa
 *    alguma coisa. Uma semana depois, ele é só uma notificação perdida. (A
 *    varredura periódica fica como rede de segurança, no scheduler.)
 *
 * 5. UM PRÊMIO POR MARCO, e isso é garantido por CLAIM ATÔMICO no banco: o
 *    código do cupom é determinístico (FIEL-<marco>-<sufixo do cliente>) e a
 *    unicidade de (code, storeId) é constraint. Duas conclusões simultâneas não
 *    geram dois prêmios — a segunda bate na constraint e desiste em silêncio.
 */
@Injectable()
export class FidelidadeService {
  private readonly logger = new Logger(FidelidadeService.name);

  /** Marcos, do maior para o menor (o maior vale primeiro na mesma rodada). */
  private static readonly MARCOS = [
    {
      chave: 'FIEL10',
      rotulo: '10 compras na loja',
      descontoPercent: 15,
      quando: (totais: { total: number; mes: number }) => totais.total > 0 && totais.total % 10 === 0,
    },
    {
      chave: 'MES5',
      rotulo: '5 compras no mês',
      descontoPercent: 10,
      quando: (totais: { total: number; mes: number }) => totais.mes > 0 && totais.mes % 5 === 0,
    },
  ];

  /** Validade do prêmio. Curta o bastante para trazer de volta, longa o bastante para caber na vida. */
  private static readonly DIAS_DE_VALIDADE = 30;

  /** A partir de quantas compras concluídas o cliente é "fiel" numa loja. */
  static readonly COMPRAS_PARA_SER_FIEL = 5;

  constructor(
    @InjectRepository(Coupon) private couponsRepository: Repository<Coupon>,
    @InjectRepository(Order) private ordersRepository: Repository<Order>,
    @InjectDataSource() private dataSource: DataSource,
    private notificationsService: NotificationsService,
    private whatsAppService: WhatsAppService,
  ) {}

  /** Compras concluídas do cliente na loja: total e no mês corrente. */
  private async contar(appUserId: string, storeId: string) {
    const [linha] = await this.ordersRepository.manager.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (
           WHERE o."completedAt" >= date_trunc('month', NOW())
         )::int AS mes
       FROM orders o
       WHERE o."customerId" = $1 AND o."storeId" = $2 AND o.status = $3`,
      [appUserId, storeId, OrderStatus.COMPLETED],
    );
    return { total: Number(linha?.total) || 0, mes: Number(linha?.mes) || 0 };
  }

  /**
   * Chamado quando um pedido é CONCLUÍDO. Nunca lança: fidelidade é bônus, e
   * uma falha aqui não pode derrubar a conclusão de um pedido já pago e
   * entregue.
   */
  async avaliarAposConclusao(order: Order): Promise<Coupon | null> {
    try {
      const appUserId = order.customer?.id;
      const storeId = order.store?.id || (order as any).storeId;
      if (!appUserId || !storeId) return null;

      const totais = await this.contar(appUserId, storeId);
      const marco = FidelidadeService.MARCOS.find((m) => m.quando(totais));
      if (!marco) return null;

      return await this.premiar(appUserId, storeId, marco, order);
    } catch (err: any) {
      this.logger.error(`avaliarAposConclusao falhou: ${err?.message || err}`);
      return null;
    }
  }

  private async premiar(
    appUserId: string,
    storeId: string,
    marco: (typeof FidelidadeService.MARCOS)[number],
    order: Order,
  ): Promise<Coupon | null> {
    // Código determinístico: o mesmo cliente, na mesma loja, no mesmo marco e
    // no mesmo mês sempre gera o MESMO código. É isso que faz a constraint de
    // unicidade (code, storeId) servir de trava contra prêmio duplicado — sem
    // depender de transação nem de lock.
    const mes = new Date().toISOString().slice(0, 7).replace('-', '');
    const sufixo = appUserId.replace(/-/g, '').slice(0, 6).toUpperCase();
    const code = `FIEL${marco.chave === 'MES5' ? 'MES' : ''}-${mes}-${sufixo}`;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + FidelidadeService.DIAS_DE_VALIDADE);

    try {
      const cupom = this.couponsRepository.create({
        code,
        discountType: 'PERCENT',
        discountValue: marco.descontoPercent,
        maxUses: 1,
        isActive: true,
        expiresAt,
        storeId,
        appUserId,
        origem: 'FIDELIDADE',
      } as any);
      const salvo = (await this.couponsRepository.save(cupom)) as unknown as Coupon;

      this.logger.log(
        `[FIDELIDADE] ${marco.chave} para cliente ${appUserId} na loja ${storeId}: ${code} (${marco.descontoPercent}%)`,
      );
      this.avisar(order, salvo, marco).catch(() => {});
      return salvo;
    } catch (err: any) {
      // 23505 = unique_violation: o prêmio deste marco já existe. É o caminho
      // esperado quando duas conclusões correm juntas — não é erro.
      if (err?.code === '23505' || /duplicate key/i.test(err?.message || '')) {
        return null;
      }
      throw err;
    }
  }

  /** Avisa o cliente pelos canais que ele já usa. Tudo best-effort. */
  private async avisar(
    order: Order,
    cupom: Coupon,
    marco: (typeof FidelidadeService.MARCOS)[number],
  ) {
    const nomeDaLoja = order.store?.name || 'a loja';
    const titulo = 'Você ganhou um cupom!';
    const corpo =
      `${marco.rotulo} em ${nomeDaLoja}: ${cupom.discountValue}% de desconto ` +
      `com o código ${cupom.code}. Válido por ${FidelidadeService.DIAS_DE_VALIDADE} dias.`;

    if (order.customer?.id) {
      await this.notificationsService
        .sendToAppUser(order.customer.id, titulo, corpo, {
          type: 'LOYALTY_COUPON',
          couponCode: cupom.code,
          storeId: order.store?.id,
        })
        .catch(() => {});
    }
    if (order.customer?.phone) {
      await this.whatsAppService
        .sendText(
          order.customer.phone,
          `🎁 *${titulo}*\n\n${corpo}\n\nObrigado por comprar com a gente!`,
        )
        .catch(() => {});
    }
  }

  /**
   * Progresso do cliente em cada loja onde já comprou — alimenta a tela de
   * fidelidade do app.
   */
  async progressoDoCliente(appUserId: string): Promise<ProgressoNaLoja[]> {
    const linhas = await this.ordersRepository.manager.query(
      `SELECT
         s.id AS "storeId",
         s.name AS "storeName",
         s."logoUrl" AS "storeLogoUrl",
         COUNT(*)::int AS "comprasConcluidas",
         COUNT(*) FILTER (WHERE o."completedAt" >= date_trunc('month', NOW()))::int AS "comprasNoMes"
       FROM orders o
       JOIN stores s ON s.id = o."storeId"
       WHERE o."customerId" = $1 AND o.status = $2
       GROUP BY s.id, s.name, s."logoUrl"
       ORDER BY "comprasConcluidas" DESC`,
      [appUserId, OrderStatus.COMPLETED],
    );

    return (linhas || []).map((l: any) => {
      const total = Number(l.comprasConcluidas) || 0;
      const mes = Number(l.comprasNoMes) || 0;
      // Mostra o marco MAIS PRÓXIMO: o que falta menos é o que motiva.
      const faltamPara10 = 10 - (total % 10 || 0) || 10;
      const faltamPara5NoMes = 5 - (mes % 5 || 0) || 5;
      const usaMes = faltamPara5NoMes <= faltamPara10;
      return {
        storeId: l.storeId,
        storeName: l.storeName,
        storeLogoUrl: l.storeLogoUrl,
        comprasConcluidas: total,
        comprasNoMes: mes,
        faltamParaOProximoPremio: usaMes ? faltamPara5NoMes : faltamPara10,
        proximoMarco: usaMes ? '5 compras no mês (10% off)' : '10 compras na loja (15% off)',
        clienteFiel: total >= FidelidadeService.COMPRAS_PARA_SER_FIEL,
      };
    });
  }

  /** Os cupons de fidelidade do cliente (o que ele tem para usar). */
  async cuponsDoCliente(appUserId: string): Promise<Coupon[]> {
    return this.couponsRepository.find({
      where: { appUserId, origem: 'FIDELIDADE' } as any,
      relations: ['store'],
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  /**
   * Clientes fiéis de uma loja — quem a loja avisa quando lança promoção.
   *
   * O teto existe para não transformar "criei uma promoção" em mil mensagens
   * de WhatsApp de uma vez: além do custo, é assim que um número é marcado
   * como spam e a loja perde o canal inteiro.
   */
  async clientesFieisDaLoja(storeId: string, limite = 200) {
    return this.ordersRepository.manager.query(
      `SELECT u.id, u.name, u.phone, u.email, COUNT(*)::int AS compras
         FROM orders o
         JOIN app_users u ON u.id = o."customerId"
        WHERE o."storeId" = $1 AND o.status = $2
        GROUP BY u.id, u.name, u.phone, u.email
       HAVING COUNT(*) >= $3
        ORDER BY compras DESC
        LIMIT $4`,
      [storeId, OrderStatus.COMPLETED, FidelidadeService.COMPRAS_PARA_SER_FIEL, limite],
    );
  }

  /**
   * Avisa os clientes fiéis da loja sobre uma novidade (promoção ou cupom).
   * Devolve quantos foram avisados.
   */
  async avisarClientesFieis(
    storeId: string,
    titulo: string,
    mensagem: string,
    dados: Record<string, any> = {},
  ): Promise<number> {
    const fieis = await this.clientesFieisDaLoja(storeId);
    let avisados = 0;
    for (const cliente of fieis) {
      await this.notificationsService
        .sendToAppUser(cliente.id, titulo, mensagem, { type: 'LOYALTY_NEWS', storeId, ...dados })
        .catch(() => {});
      avisados++;
    }
    this.logger.log(`[FIDELIDADE] ${avisados} cliente(s) fiel(eis) avisados da loja ${storeId}`);
    return avisados;
  }

  /**
   * Rede de segurança: varre as conclusões recentes e premia o que o caminho
   * normal não premiou (API caiu no meio, erro de rede na notificação, etc.).
   * Roda no scheduler, dentro da trava distribuída.
   */
  async varrerPendentes(dias = 2): Promise<number> {
    const recentes = await this.ordersRepository.manager.query(
      `SELECT DISTINCT o."customerId", o."storeId"
         FROM orders o
        WHERE o.status = $1
          AND o."completedAt" >= NOW() - ($2 || ' days')::interval`,
      [OrderStatus.COMPLETED, String(dias)],
    );
    let premiados = 0;
    for (const r of recentes || []) {
      const totais = await this.contar(r.customerId, r.storeId);
      const marco = FidelidadeService.MARCOS.find((m) => m.quando(totais));
      if (!marco) continue;
      // Reaproveita o caminho normal; o código determinístico + constraint
      // garantem que não sai prêmio repetido.
      const ordem = await this.ordersRepository.findOne({
        where: { customer: { id: r.customerId }, store: { id: r.storeId }, status: OrderStatus.COMPLETED } as any,
        relations: ['customer', 'store'],
        order: { completedAt: 'DESC' },
      });
      if (!ordem) continue;
      const cupom = await this.premiar(r.customerId, r.storeId, marco, ordem).catch(() => null);
      if (cupom) premiados++;
    }
    return premiados;
  }
}
