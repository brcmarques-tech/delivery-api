import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RepasseEntregador } from './entities/repasse-entregador.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { corteDoFechamento, dataDePagamento } from './ciclo-de-repasse';

/** Um frete retido ainda não pago. */
export interface FreteEmAberto {
  orderId: string;
  orderNumber: string;
  loja: string;
  cents: number;
  concluidoEm: Date;
  pagamentoPrevisto: Date;
  delivererId: string;
}

/**
 * Repasse semanal ao entregador (modelo iFood): o frete que a plataforma reteve
 * no PIX vira SALDO do entregador e é pago em lote toda quarta, pelas entregas
 * de segunda a domingo da semana anterior.
 *
 * O valor de cada pedido já existia (`orders.delivererPayableCents`, gravado no
 * settle); aqui ele ganha ciclo, saldo, fechamento e baixa em lote. O
 * pagamento em si é feito fora (PIX do banco da empresa) e registrado aqui.
 */
@Injectable()
export class RepassesEntregadorService {
  private readonly logger = new Logger(RepassesEntregadorService.name);

  constructor(
    @InjectRepository(RepasseEntregador)
    private repasses: Repository<RepasseEntregador>,
    private dataSource: DataSource,
    private notifications: NotificationsService,
  ) {}

  /** Fretes retidos e ainda não pagos — de um entregador, ou de todos. */
  async fretesEmAberto(delivererId?: string): Promise<FreteEmAberto[]> {
    const linhas: any[] = await this.dataSource.query(
      `SELECT o.id AS "orderId", o."orderNumber" AS "orderNumber", s.name AS loja,
              o."delivererPayableCents" AS cents, d."delivererId" AS "delivererId",
              COALESCE(o."completedAt", o."delivererSettledAt", o."updatedAt") AS "concluidoEm"
         FROM orders o
         JOIN deliveries d ON d."orderId" = o.id
         JOIN stores s ON s.id = o."storeId"
        WHERE o."delivererPayableCents" > 0
          AND o."delivererPayablePaidAt" IS NULL
          AND d."delivererId" IS NOT NULL
          ${delivererId ? 'AND d."delivererId" = $1' : ''}
        ORDER BY "concluidoEm" ASC`,
      delivererId ? [delivererId] : [],
    );
    return linhas.map((l) => {
      const concluidoEm = new Date(l.concluidoEm);
      return { ...l, cents: Number(l.cents), concluidoEm, pagamentoPrevisto: dataDePagamento(concluidoEm) };
    });
  }

  /** O que o próprio entregador vê: saldo, próxima quarta e o que já recebeu. */
  async saldoDoEntregador(delivererId: string) {
    const abertos = await this.fretesEmAberto(delivererId);
    const [usuario] = await this.dataSource.query(`SELECT "chavePix" FROM app_users WHERE id = $1`, [delivererId]);
    const pagos = await this.repasses.find({ where: { delivererId }, order: { pagoEm: 'DESC' }, take: 12 });
    const proximo = abertos[0]?.pagamentoPrevisto ?? null;
    return {
      aReceberCents: abertos.reduce((s, f) => s + f.cents, 0),
      proximoPagamento: proximo,
      proximoPagamentoCents: proximo
        ? abertos.filter((f) => f.pagamentoPrevisto.getTime() === proximo.getTime()).reduce((s, f) => s + f.cents, 0)
        : 0,
      entregas: abertos,
      pagos,
      chavePix: usuario?.chavePix ?? null,
    };
  }

  /**
   * Fechamento de quarta para o superadmin: por entregador, o que entra no
   * pagamento desta semana (concluído até o domingo que passou) e o que já
   * está acumulando para a próxima.
   */
  async fechamento(agora = new Date()) {
    const corte = corteDoFechamento(agora);
    const abertos = await this.fretesEmAberto();
    const porEntregador = new Map<string, { devido: FreteEmAberto[]; proximo: FreteEmAberto[] }>();
    for (const f of abertos) {
      const g = porEntregador.get(f.delivererId) ?? { devido: [], proximo: [] };
      (f.concluidoEm < corte ? g.devido : g.proximo).push(f);
      porEntregador.set(f.delivererId, g);
    }
    const ids = [...porEntregador.keys()];
    const pessoas: any[] = ids.length
      ? await this.dataSource.query(
          `SELECT id, name, phone, "chavePix" FROM app_users WHERE id = ANY($1::uuid[])`,
          [ids],
        )
      : [];
    const porId = new Map(pessoas.map((p) => [p.id, p]));
    const soma = (l: FreteEmAberto[]) => l.reduce((s, f) => s + f.cents, 0);
    const entregadores = ids
      .map((id) => {
        const g = porEntregador.get(id)!;
        const p = porId.get(id) ?? {};
        return {
          delivererId: id,
          nome: p.name ?? '—',
          telefone: p.phone ?? null,
          chavePix: p.chavePix ?? null,
          devidoCents: soma(g.devido),
          devidoQuantidade: g.devido.length,
          proximoCicloCents: soma(g.proximo),
          pedidos: g.devido.map((f) => f.orderNumber),
        };
      })
      .sort((a, b) => b.devidoCents - a.devidoCents);
    return {
      corte,
      dataDePagamento: new Date(corte.getTime() + 2 * 24 * 60 * 60 * 1000),
      totalDevidoCents: entregadores.reduce((s, e) => s + e.devidoCents, 0),
      totalProximoCicloCents: entregadores.reduce((s, e) => s + e.proximoCicloCents, 0),
      entregadores,
    };
  }

  /**
   * Registra que o entregador foi pago: baixa de uma vez todos os fretes dele
   * concluídos antes do corte. Atômico — dois cliques não pagam duas vezes, e
   * frete que entrar no meio fica para o próximo lote.
   */
  async registrarPagamento(delivererId: string, pagoPor: string, observacao?: string, agora = new Date()) {
    const corte = corteDoFechamento(agora);
    const repasse = await this.dataSource.transaction(async (m) => {
      const [pessoa] = await m.query(`SELECT name, "chavePix" FROM app_users WHERE id = $1`, [delivererId]);
      if (!pessoa) throw new BadRequestException('Entregador não encontrado.');
      const pedidos: any[] = await m.query(
        `SELECT o.id, o."delivererPayableCents" AS cents
           FROM orders o JOIN deliveries d ON d."orderId" = o.id
          WHERE d."delivererId" = $1
            AND o."delivererPayableCents" > 0
            AND o."delivererPayablePaidAt" IS NULL
            AND COALESCE(o."completedAt", o."delivererSettledAt", o."updatedAt") < $2
          FOR UPDATE OF o`,
        [delivererId, corte],
      );
      if (pedidos.length === 0) {
        throw new BadRequestException('Este entregador não tem nada a receber neste fechamento.');
      }
      const total = pedidos.reduce((s, p) => s + Number(p.cents), 0);
      const salvo = await m.getRepository(RepasseEntregador).save(
        m.getRepository(RepasseEntregador).create({
          delivererId,
          totalCents: total,
          quantidade: pedidos.length,
          corte,
          chavePix: pessoa.chavePix ?? null,
          observacao: observacao?.trim() || null,
          pagoPor,
        }),
      );
      await m.query(
        `UPDATE orders SET "delivererPayablePaidAt" = NOW(), "delivererPayoutId" = $1
          WHERE id = ANY($2::uuid[])`,
        [salvo.id, pedidos.map((p) => p.id)],
      );
      return salvo;
    });

    const reais = (repasse.totalCents / 100).toFixed(2).replace('.', ',');
    this.notifications
      .sendToAppUser(
        delivererId,
        'Repasse feito',
        `Pagamos R$ ${reais} das suas ${repasse.quantidade} entrega(s) da semana.`,
        { type: 'REPASSE_SEMANAL', repasseId: repasse.id },
      )
      .catch(() => {});
    this.logger.log(`[REPASSE_SEMANAL] entregador ${delivererId} | ${repasse.totalCents} centavos | ${repasse.quantidade} pedido(s)`);
    return repasse;
  }

  async historico(limit = 50) {
    const lista = await this.repasses.find({ order: { pagoEm: 'DESC' }, take: Math.min(limit, 200) });
    const ids = [...new Set(lista.map((r) => r.delivererId))];
    const nomes: any[] = ids.length
      ? await this.dataSource.query(`SELECT id, name FROM app_users WHERE id = ANY($1::uuid[])`, [ids])
      : [];
    const porId = new Map(nomes.map((n) => [n.id, n.name]));
    return lista.map((r) => Object.assign(r, { delivererNome: porId.get(r.delivererId) ?? null }));
  }

  /** A chave do próprio entregador. Validação de formato, não de existência. */
  async salvarChavePix(delivererId: string, chave: string): Promise<string> {
    const limpa = (chave || '').trim();
    const digitos = limpa.replace(/\D/g, '');
    const valida =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpa) || // e-mail
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(limpa) || // aleatória
      (/^[\d.\-/()+\s]+$/.test(limpa) && [11, 13, 14].includes(digitos.length)); // CPF, celular (+55) ou CNPJ
    if (!valida) {
      throw new BadRequestException('Chave PIX inválida. Use CPF, CNPJ, celular, e-mail ou chave aleatória.');
    }
    await this.dataSource.query(`UPDATE app_users SET "chavePix" = $1 WHERE id = $2`, [limpa, delivererId]);
    return limpa;
  }
}
