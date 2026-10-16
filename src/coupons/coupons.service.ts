import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In, EntityManager } from 'typeorm';
import { claimGanho } from '../common/utils/db-claim';
import { OrderStatus } from '../common/enums';
import { Coupon } from './entities/coupon.entity';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';
import { Store } from '../stores/entities/store.entity';
import { Order } from '../orders/entities/order.entity';
import { PlatformConfigService } from '../config/platform-config.service';
import { FidelidadeService } from '../loyalty/fidelidade.service';
import { EquipeService } from '../team/equipe.service';
import { ModuloDaLoja } from '../team/entities/vendor-team-member.entity';

@Injectable()
export class CouponsService {
  constructor(
    @InjectRepository(Coupon)
    private couponsRepository: Repository<Coupon>,
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    private platformConfigService: PlatformConfigService,
    private fidelidadeService: FidelidadeService,
    // KAN-82: autorizacao de loja passou a ser "dono OU membro da equipe
    // com o modulo", em vez de so "e o dono?".
    private equipeService: EquipeService,
  ) {}

  async create(input: CreateCouponInput, userId: string): Promise<Coupon> {
    const store = await this.storesRepository.findOne({
      where: { id: input.storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    await this.equipeService.exigirPermissao(
      userId,
      store.id,
      ModuloDaLoja.COUPONS,
      'Voce nao e dono desta loja',
    );

    // Check plan allows coupons
    const plan = store.owner.vendorPlan || 'FREE';
    const config = await this.platformConfigService.getPlanConfig(plan);
    if (!config.canUseCoupons) {
      throw new BadRequestException(
        'Seu plano nao permite criar cupons. Faca upgrade para PRO ou superior.',
      );
    }

    // Normalize code to uppercase
    const code = input.code.trim().toUpperCase();

    // Check unique code per store
    const existing = await this.couponsRepository.findOne({
      where: { code, store: { id: input.storeId } },
    });
    if (existing) {
      throw new BadRequestException('Ja existe um cupom com este codigo nesta loja');
    }

    if (input.discountType === 'PERCENT' && input.discountValue > 100) {
      throw new BadRequestException('Desconto percentual nao pode ser maior que 100%');
    }

    const coupon = this.couponsRepository.create({
      code,
      discountType: input.discountType,
      discountValue: input.discountValue,
      minimumOrder: input.minimumOrder,
      maxDiscount: input.maxDiscount,
      maxUses: input.maxUses || 0,
      expiresAt: input.expiresAt,
      store,
    });

    const salvo = await this.couponsRepository.save(coupon);

    // KAN-12: cupom novo da loja e motivo para chamar quem ja compra ali.
    // So vale para cupom ABERTO: premio de fidelidade (nominal) nao se anuncia
    // para a base — ele e de uma pessoa so.
    if (!salvo.appUserId && salvo.isActive) {
      this.fidelidadeService
        .avisarClientesFieis(
          store.id,
          `Cupom novo em ${store.name}`,
          salvo.discountType === 'PERCENT'
            ? `${salvo.discountValue}% de desconto com o codigo ${salvo.code}`
            : `R$ ${Number(salvo.discountValue).toFixed(2)} de desconto com o codigo ${salvo.code}`,
          { couponCode: salvo.code },
        )
        .catch(() => {});
    }

    return salvo;
  }

  async update(input: UpdateCouponInput, userId: string): Promise<Coupon> {
    const coupon = await this.couponsRepository.findOne({
      where: { id: input.id },
      relations: ['store', 'store.owner'],
    });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    await this.equipeService.exigirPermissao(
      userId,
      coupon.store?.id,
      ModuloDaLoja.COUPONS,
      'Voce nao e dono desta loja',
    );

    if (input.code) coupon.code = input.code.trim().toUpperCase();
    if (input.discountType) coupon.discountType = input.discountType;
    if (input.discountValue !== undefined) coupon.discountValue = input.discountValue;
    if (input.minimumOrder !== undefined) coupon.minimumOrder = input.minimumOrder;
    if (input.maxDiscount !== undefined) coupon.maxDiscount = input.maxDiscount;
    if (input.maxUses !== undefined) coupon.maxUses = input.maxUses;
    if (input.expiresAt !== undefined) coupon.expiresAt = input.expiresAt;

    // Input#4: re-checa o cap de 100% no UPDATE. O create já barrava, mas o update
    // atribuía o discountValue sem checar — dava pra criar um cupom válido e depois
    // editá-lo para 100% (pedido de graça) ou percentual absurdo.
    if (coupon.discountType === 'PERCENT' && Number(coupon.discountValue) > 100) {
      throw new BadRequestException('Desconto percentual nao pode ser maior que 100%');
    }

    return this.couponsRepository.save(coupon);
  }

  async toggleActive(id: string, userId: string): Promise<Coupon> {
    const coupon = await this.couponsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner'],
    });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    await this.equipeService.exigirPermissao(
      userId,
      coupon.store?.id,
      ModuloDaLoja.COUPONS,
      'Voce nao e dono desta loja',
    );
    coupon.isActive = !coupon.isActive;
    return this.couponsRepository.save(coupon);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const coupon = await this.couponsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner'],
    });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    await this.equipeService.exigirPermissao(
      userId,
      coupon.store?.id,
      ModuloDaLoja.COUPONS,
      'Voce nao e dono desta loja',
    );
    await this.couponsRepository.remove(coupon);
    return true;
  }

  async findByStore(storeId: string, userId?: string): Promise<Coupon[]> {
    // Cupom carrega config de negócio (code secreto, maxUses, minimumOrder). Sem
    // checar posse, qualquer usuário logado listava TODOS os cupons de QUALQUER
    // loja — inclusive inativos/expirados — e resgatava os ativos. Quando o
    // chamador passa userId (resolver do vendor), exigimos que seja o dono.
    if (userId) {
      const store = await this.storesRepository.findOne({
        where: { id: storeId },
        relations: ['owner'],
      });
      if (!store) throw new BadRequestException('Voce nao e dono desta loja');
      await this.equipeService.exigirPermissao(
        userId,
        store.id,
        ModuloDaLoja.COUPONS,
        'Voce nao e dono desta loja',
      );
    }
    return this.couponsRepository.find({
      where: { store: { id: storeId } },
      relations: ['store'],
      order: { createdAt: 'DESC' },
    });
  }

  // ─── Superadmin ───

  async findAll(): Promise<Coupon[]> {
    return this.couponsRepository.find({
      relations: ['store', 'store.owner'],
      order: { createdAt: 'DESC' },
    });
  }

  async adminToggle(id: string): Promise<Coupon> {
    const coupon = await this.couponsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner'],
    });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    coupon.isActive = !coupon.isActive;
    return this.couponsRepository.save(coupon);
  }

  async adminDelete(id: string): Promise<boolean> {
    const coupon = await this.couponsRepository.findOne({ where: { id } });
    if (!coupon) throw new NotFoundException('Cupom nao encontrado');
    await this.couponsRepository.remove(coupon);
    return true;
  }

  /** Validate and calculate discount for a coupon code at checkout */
  async validateAndCalculate(
    code: string,
    storeId: string,
    subtotal: number,
    customerId?: string,
  ): Promise<{ coupon: Coupon; discount: number }> {
    const coupon = await this.couponsRepository.findOne({
      where: { code: code.trim().toUpperCase(), store: { id: storeId } },
      relations: ['store'],
    });

    if (!coupon) {
      throw new BadRequestException('Cupom nao encontrado');
    }

    if (!coupon.isActive) {
      throw new BadRequestException('Este cupom esta desativado');
    }

    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
      throw new BadRequestException('Este cupom expirou');
    }

    // KAN-12: cupom NOMINAL (premio de fidelidade) so vale para quem ganhou.
    // Sem esta checagem bastava o codigo circular num grupo de WhatsApp para a
    // recompensa — que sai do bolso da loja — ir para quem nunca comprou.
    //
    // A mensagem NAO diz "este cupom e de outra pessoa": isso confirmaria a
    // existencia do codigo para quem esta testando codigos alheios.
    if (coupon.appUserId && coupon.appUserId !== customerId) {
      throw new BadRequestException('Cupom nao encontrado');
    }

    if (coupon.maxUses > 0 && coupon.usesCount >= coupon.maxUses) {
      throw new BadRequestException('Este cupom ja atingiu o limite de usos');
    }

    // M1: Per-user coupon usage limit (1 use per customer per coupon)
    if (customerId) {
      const orderRepo = this.couponsRepository.manager.getRepository(Order);
      // BL#5: não contar pedidos CANCELADOS/EXPIRADOS/REJEITADOS. O uso do cupom
      // nesses casos já foi devolvido (decrementUsage), então contá-los bloqueava
      // permanentemente um cliente que usou o cupom num pedido que depois caiu —
      // efetivamente ele nunca consumiu o cupom.
      const userUsageCount = await orderRepo.count({
        where: {
          customer: { id: customerId },
          coupon: { id: coupon.id },
          status: Not(In([
            OrderStatus.CANCELLED,
            OrderStatus.EXPIRED,
            OrderStatus.REJECTED,
          ])),
        },
      });
      if (userUsageCount > 0) {
        throw new BadRequestException('Voce ja utilizou este cupom');
      }
    }

    if (coupon.minimumOrder && subtotal < Number(coupon.minimumOrder)) {
      throw new BadRequestException(
        `Pedido minimo de R$ ${Number(coupon.minimumOrder).toFixed(2)} para usar este cupom`,
      );
    }

    let discount: number;
    if (coupon.discountType === 'PERCENT') {
      discount = Math.round((subtotal * Number(coupon.discountValue)) / 100 * 100) / 100;
      if (coupon.maxDiscount && discount > Number(coupon.maxDiscount)) {
        discount = Number(coupon.maxDiscount);
      }
    } else {
      discount = Number(coupon.discountValue);
    }

    // Discount cannot exceed subtotal
    if (discount > subtotal) {
      discount = subtotal;
    }

    return { coupon, discount };
  }

  /**
   * Increment usage count after order is created.
   *
   * A tabela é `coupons` (@Entity('coupons')); as quatro queries cruas de
   * contador do sistema escreviam em `coupon`, que não existe. O Postgres
   * respondia `relation "coupon" does not exist` em TODAS elas, com dois efeitos:
   *
   * 1. `maxUses` nunca era aplicado de verdade — `usesCount` ficava travado em
   *    zero para sempre, então um cupom de "10 usos" valia infinitas vezes.
   * 2. Aqui o erro NÃO era engolido, e a chamada acontece dentro da transação de
   *    `createOrder`: todo pedido com cupom pago na entrega abortava inteiro.
   *    (Os decrementos ficam em try/catch, então esses apenas logavam.)
   */
  /**
   * Reserva/consome UM uso do cupom de forma atômica-condicional. Retorna
   * `true` se reservou, `false` se o cupom ja atingiu `maxUses`.
   *
   * C4 + cupom multi-uso: a checagem `usesCount >= maxUses` do
   * `validateAndCalculate` e este incremento nao sao a mesma operacao. A
   * reserva agora acontece na CRIACAO do pedido (para todos os metodos de
   * pagamento) — antes, o pagamento online so incrementava no webhook, e na
   * janela entre criar e pagar (minutos/horas) N clientes passavam no check e
   * todos ganhavam o desconto de um cupom de uso unico. Chamar dentro da
   * transacao do pedido (passando `manager`) garante que o rollback do pedido
   * desfaca a reserva. O `WHERE ... (maxUses=0 OR usesCount<maxUses)` + o
   * RETURNING dizem se havia slot.
   */
  async incrementUsage(couponId: string, manager?: EntityManager): Promise<boolean> {
    const runner = manager ?? this.couponsRepository.manager;
    const claim = await runner.query(
      `UPDATE coupons SET "usesCount" = "usesCount" + 1 WHERE id = $1 AND ("maxUses" = 0 OR "usesCount" < "maxUses") RETURNING id`,
      [couponId],
    );
    // ESTE CLAIM ESTAVA INERTE (achado na auditoria de 15/10/2026).
    //
    // A decisao era `Array.isArray(rows) && rows.length > 0`. Com o driver do
    // TypeORM, UPDATE com RETURNING devolve `[linhas, contagem]` — array de
    // comprimento 2 SEMPRE, inclusive quando a condicao do WHERE nao casou e
    // nenhuma linha foi afetada. Ou seja: a funcao respondia "reservei" mesmo
    // com o cupom esgotado, e o `if (!reservado) throw` em createOrder nunca
    // disparava.
    //
    // Na pratica o limite seguia valendo por causa do pre-check nao-atomico do
    // `validateAndCalculate` — e e exatamente esse pre-check que o comentario
    // acima descreve como insuficiente: entre a validacao e a reserva existe uma
    // janela em que N clientes leem `usesCount` igual. A rede de seguranca
    // contra essa janela e este claim, e ela estava desligada.
    //
    // Mesma classe dos 23 claims corrigidos em delivery-api@44ca510; este
    // arquivo ficou fora daquela varredura, que cobriu orders, payments e
    // verification.
    return claimGanho(claim);
  }

  /** H2: Decrement usage count when order is cancelled/rejected/expired */
  async decrementUsage(couponId: string): Promise<void> {
    // Only decrement if usesCount > 0 to avoid negative values
    await this.couponsRepository.manager.query(
      `UPDATE coupons SET "usesCount" = GREATEST("usesCount" - 1, 0) WHERE id = $1`,
      [couponId],
    );
  }
}
