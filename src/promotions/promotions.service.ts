import { Injectable, NotFoundException, BadRequestException, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, LessThan, MoreThan, DataSource } from 'typeorm';
import { comTravaDistribuida } from '../common/utils/trava-distribuida';
import { PubSub } from 'graphql-subscriptions';
import { Promotion } from './entities/promotion.entity';
import { CreatePromotionInput } from './dto/create-promotion.input';
import { StoresService } from '../stores/stores.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { Product } from '../products/entities/product.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { FidelidadeService } from '../loyalty/fidelidade.service';

@Injectable()
export class PromotionsService implements OnModuleInit {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(
    @InjectRepository(Promotion)
    private promotionsRepository: Repository<Promotion>,
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    private storesService: StoresService,
    private platformConfigService: PlatformConfigService,
    private whatsAppService: WhatsAppService,
    @Inject(PUB_SUB) private pubSub: PubSub,
    @InjectDataSource() private dataSource: DataSource,
    private fidelidadeService: FidelidadeService,
  ) {}

  onModuleInit() {
    // KAN-253: as duas chamadas descartavam a Promise. Se algo escapar do
    // try/catch interno vira unhandled rejection — e a primeira roda no boot,
    // onde uma falha nao tratada e ainda mais sensivel.
    // KAN-254: as duas rotinas mexem em PRECO DE VENDA (promotionalPrice) —
    // duas instancias rodando juntas disputam as mesmas linhas de produto. A
    // trava do banco deixa so uma passar por rodada (ver trava-distribuida).
    //
    // Elas tambem passaram a rodar em SEQUENCIA dentro da trava: sao
    // complementares (uma limpa o que venceu, a outra aplica o que comecou) e
    // disparadas em paralelo podiam se cruzar na mesma linha.
    const run = () => {
      comTravaDistribuida(this.dataSource, 'tick:promocoes', async () => {
        await this.clearExpiredPromotions();
        // Contraparte da limpeza: aplica o desconto das promocoes pagas cuja
        // janela ja comecou (ate agora nada fazia isso — ver activateDuePromotions).
        await this.activateDuePromotions();
      }).catch((err) => this.logger.error('tick de promocoes falhou:', err));
    };
    run();
    setInterval(run, 5 * 60 * 1000);
  }

  /**
   * Broadcast de promoção SEM dados sensíveis do vendedor. O canal público
   * promotionUpdated era assinado por qualquer um e carregava checkoutUrl (link
   * de pagamento Pagar.me) e adCost (gasto com anúncio). O vendedor recebe o
   * checkoutUrl na resposta da própria mutation; o feed de clientes não precisa.
   * checkoutUrl é nullable; adCost é não-nullable, então vai zerado (não null).
   */
  private publishPromotionUpdate(saved: Promotion) {
    this.pubSub.publish('promotionUpdated', {
      promotionUpdated: { ...saved, checkoutUrl: null, adCost: 0 },
    });
  }

  // BUGFIX: existia apenas a limpeza de promocoes VENCIDAS — nada nunca ATIVAVA
  // uma promocao paga cuja janela comeca no futuro. O vendedor pagava por uma
  // campanha para segunda-feira, o webhook aplicava o desconto so se `now` ja
  // estivesse dentro da janela (nao estava), e na segunda ninguem reaplicava:
  // o produto seguia com preco cheio e a campanha paga simplesmente nao rodava.
  /**
   * A CAMPANHA VIGENTE de um produto.
   *
   * Esta condição é a definição única de "está valendo agora", e os dois
   * schedulers abaixo passaram a ser complementares em cima dela: um aplica o
   * preço de quem está vigente, o outro limpa o preço de quem não tem ninguém
   * vigente. Juntos determinam inteiramente o `promotionalPrice` do produto.
   *
   * Isso importa porque `product.promotionalPrice` É O PREÇO DE VENDA —
   * `orders.service` calcula o subtotal com `promotionalPrice || price`, e
   * desse subtotal saem a comissão e a fatia de cada um no split.
   *
   * O campo pertence exclusivamente a este módulo: além destes schedulers, só
   * `markAsPaid`, `toggleActive`, `swapProduct` e `delete` o escrevem, e os
   * quatro já conferem esta mesma janela. É isso que permite tratar os dois
   * schedulers como a autoridade sobre ele.
   */
  private static readonly CAMPANHA_VIGENTE = `
               pr."isPaid" = true
           AND pr."isActive" = true
           AND pr."startDate" <= NOW()
           AND pr."endDate" >= NOW()
           AND pr."promotionalPrice" IS NOT NULL`;

  /**
   * Aplica o preço da campanha vigente.
   *
   * BUGFIX (16/10/2026): O PREÇO OSCILAVA ENTRE RODADAS DO SCHEDULER.
   *
   * O `UPDATE ... FROM promotions` casava TODAS as campanhas vigentes do
   * produto. Com duas pagas e ativas no mesmo produto — o `create` só limita a
   * QUANTIDADE por semana pela cota do plano, nada impede duas no mesmo
   * produto — o Postgres escolhia uma arbitrariamente, e a condição
   * `IS DISTINCT FROM` fazia a query achar a OUTRA na rodada seguinte e trocar
   * o preço de novo.
   *
   * Medido em banco descartável (scripts/provas/prova-promocoes-preco.mjs),
   * produto de R$ 100 com campanhas de R$ 80 e de R$ 60:
   *
   *     1a rodada: R$ 60,00
   *     2a rodada: R$ 80,00
   *     3a rodada: R$ 60,00
   *
   * O scheduler roda a cada minuto. O cliente pagava um preço diferente
   * conforme o minuto em que abrisse a tela, e a comissão saía desse valor.
   *
   * O conserto é o `DISTINCT ON`: uma campanha por produto, escolhida por
   * regra explícita — a de início mais RECENTE, e em empate a criada mais
   * recentemente. É o que corresponde à intuição de quem anuncia: a última
   * campanha que eu lancei é a que está no ar.
   */
  private async activateDuePromotions() {
    try {
      await this.productsRepository.manager.query(`
        UPDATE products p
        SET "promotionalPrice" = vigente."promotionalPrice"
        FROM (
          SELECT DISTINCT ON (pr."productId")
                 pr."productId",
                 pr."promotionalPrice"
            FROM promotions pr
           WHERE ${PromotionsService.CAMPANHA_VIGENTE}
           ORDER BY pr."productId", pr."startDate" DESC, pr."createdAt" DESC
        ) vigente
        WHERE vigente."productId" = p.id
          AND p."promotionalPrice" IS DISTINCT FROM vigente."promotionalPrice"
      `);
    } catch (err) {
      this.logger.error('Error activating due promotions', err);
    }
  }

  /**
   * Limpa o preço promocional de quem não tem campanha vigente.
   *
   * BUGFIX (16/10/2026): O PREÇO DE UMA CAMPANHA VENCIDA FICAVA PARA SEMPRE.
   *
   * O guarda do `NOT EXISTS` conferia `isPaid` mas NÃO `isActive`. Então uma
   * campanha paga que o lojista DESLIGOU, com janela futura, bloqueava a
   * limpeza — e nunca ia aplicar o preço dela, porque o ativador exige
   * `isActive`. Resultado: o produto ficava preso no preço de uma campanha
   * vencida, vendendo mais barato indefinidamente.
   *
   * Medido na mesma prova: produto de R$ 200 com campanha vencida de R$ 150 e
   * uma paga-mas-desligada para a semana seguinte ficou em R$ 150,00 depois da
   * limpeza.
   *
   * Havia um segundo caso pelo mesmo motivo: campanha paga e ativa com janela
   * FUTURA também bloqueava a limpeza, então o preço da vencida continuava
   * valendo no intervalo entre as duas, em vez de o produto voltar ao preço
   * cheio.
   *
   * O conserto é o complemento exato do ativador: limpa quando NINGUÉM está
   * vigente. Também deixei de exigir o join com uma campanha vencida — assim a
   * limpeza alcança o preço órfão de uma campanha apagada (promoção não tem
   * soft-delete), que antes ficava para sempre.
   */
  private async clearExpiredPromotions() {
    try {
      await this.productsRepository.manager.query(`
        UPDATE products p
        SET "promotionalPrice" = NULL
        WHERE p."promotionalPrice" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM promotions pr
             WHERE pr."productId" = p.id
               AND ${PromotionsService.CAMPANHA_VIGENTE}
          )
      `);
    } catch (err) {
      this.logger.error('Error clearing expired promotions', err);
    }
  }

  async create(input: CreatePromotionInput, user: VendorUser): Promise<Promotion> {
    const store = await this.storesService.findById(input.storeId);
    if (store.owner.id !== user.id) {
      throw new BadRequestException('Voce nao e o dono dessa loja.');
    }

    const hasBadgeCredit = store.freePromoDaysCredit > 0;
    const planConfig = await this.platformConfigService.getPlanConfig(user.vendorPlan || 'FREE');

    if (!hasBadgeCredit) {
      if (planConfig.freePromosPerWeek <= 0) {
        throw new BadRequestException(
          'Seu plano nao permite criar promocoes. Faca upgrade para o plano Pro ou superior.',
        );
      }

      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);

      const promosThisWeek = await this.promotionsRepository.count({
        where: {
          store: { owner: { id: user.id } },
          createdAt: MoreThan(startOfWeek),
        },
      });

      if (promosThisWeek >= planConfig.freePromosPerWeek) {
        throw new BadRequestException(
          `Seu plano permite no maximo ${planConfig.freePromosPerWeek} promocao(oes) por semana. Faca upgrade para criar mais.`,
        );
      }
    }

    let product: Product | null = null;
    if (input.productId) {
      product = await this.productsRepository.findOne({
        where: { id: input.productId, store: { id: input.storeId } },
      });
      if (!product) throw new NotFoundException('Produto nao encontrado');
    }

    const pricePerDay = await this.platformConfigService.getPromoPricePerDay();
    const start = new Date(input.startDate);
    const end = new Date(input.endDate);
    const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

    let paidDays = totalDays;
    let usedFreeDays = 0;
    if (store.freePromoDaysCredit > 0) {
      usedFreeDays = Math.min(store.freePromoDaysCredit, totalDays);
      paidDays = totalDays - usedFreeDays;
    }

    let discount = 0;
    if (paidDays >= 365) discount = 0.30;
    else if (paidDays >= 30) discount = 0.20;
    else if (paidDays >= 7) discount = 0.10;
    const adCost = paidDays > 0 ? paidDays * pricePerDay * (1 - discount) : 0;

    // BUGFIX: `create` nao validava a faixa do preco promocional (so @Min(0) no
    // DTO), enquanto `swapProduct` ja exigia ser menor que o preco do produto.
    // Sem isto dava para criar promocao com preco ACIMA do normal — e o pedido
    // usa `promotionalPrice || price`, entao a "promocao" cobrava MAIS caro do
    // cliente. E o 0 permitido virava produto de graca (subtotal e comissao 0).
    if (product && input.promotionalPrice !== undefined && input.promotionalPrice !== null) {
      if (Number(input.promotionalPrice) <= 0) {
        throw new BadRequestException('O preco promocional deve ser maior que zero.');
      }
      if (Number(input.promotionalPrice) >= Number(product.price)) {
        throw new BadRequestException(
          'O preco promocional deve ser menor que o preco atual do produto.',
        );
      }
    }

    const promotion = new Promotion();
    promotion.title = input.title;
    if (input.description) promotion.description = input.description;
    const imgUrl = product?.imageUrl || input.imageUrl;
    if (imgUrl) promotion.imageUrl = imgUrl;
    promotion.startDate = input.startDate;
    promotion.endDate = input.endDate;
    promotion.promotionalPrice = input.promotionalPrice;
    promotion.adCost = adCost;
    promotion.store = store;
    if (product) promotion.product = product;
    const saved = await this.promotionsRepository.save(promotion);
    this.publishPromotionUpdate(saved);

    if (usedFreeDays > 0) {
      // R#6: decremento ATÔMICO do crédito de dias grátis. ANTES era um
      // read-modify-write (`saveStore`) sem lock: duas promoções simultâneas liam
      // o mesmo saldo e o last-write-wins descontava o crédito uma única vez para
      // as duas. Agora o UPDATE aplica os dois decrementos de fato (clampando em 0).
      // (Resíduo: se ambas quiserem MAIS dias grátis do que o saldo total no mesmo
      // instante, ainda pode haver leve sobre-concessão; travar 100% exige um claim
      // do saldo antes de calcular `usedFreeDays`.)
      await this.productsRepository.manager.query(
        `UPDATE stores SET "freePromoDaysCredit" = GREATEST("freePromoDaysCredit" - $2, 0) WHERE id = $1`,
        [store.id, usedFreeDays],
      );
    }

    if (user.phone) {
      this.whatsAppService.notifyPromotionCreated(
        user.phone,
        store.name,
        input.title,
        adCost.toFixed(2),
      ).catch(() => {});
    }

    return saved;
  }

  async saveCheckoutUrl(id: string, checkoutUrl: string): Promise<void> {
    await this.promotionsRepository.update(id, { checkoutUrl });
  }

  /** Predicado de "promocao visivel ao publico" — um lugar so. */
  private static vitrineWhere(now: Date) {
    return {
      isActive: true,
      isPaid: true,
      startDate: LessThanOrEqual(now),
      endDate: MoreThanOrEqual(now),
    };
  }

  // Perf (F6): era sempre a lista completa de promocoes ativas. Os tres
  // consumidores no app mostravam no maximo algumas (a home num carrossel, a
  // busca cortando em 6) e a tela de DETALHE baixava a lista inteira so para
  // achar uma por id. Agora aceita limit/offset; sem eles, o retorno e o mesmo.
  async findActive(opcoes?: { limit?: number; offset?: number }): Promise<Promotion[]> {
    const now = new Date();
    const take = Math.min(Math.max(Number(opcoes?.limit) || 0, 0), 100) || undefined;
    const skip = Math.max(Number(opcoes?.offset) || 0, 0) || undefined;
    return this.promotionsRepository.find({
      where: PromotionsService.vitrineWhere(now),
      relations: ['store', 'product'],
      // DESEMPATE OBRIGATORIO. Era so `createdAt DESC`, e isso basta enquanto
      // ninguem pagina: com empate de data o Postgres nao garante ordem nenhuma,
      // e a ordem pode mudar DE UMA REQUISICAO PARA OUTRA. No momento em que
      // esta lista passou a ser paginada isso virou perda e duplicacao de item
      // entre paginas — a pagina 2 podia repetir algo da 1 e esconder outro para
      // sempre. E empate aqui nao e hipotetico: promocoes criadas no mesmo lote
      // (ou em segundos) compartilham o `createdAt`. O `id` e unico, entao a
      // ordem fica total e estavel.
      order: { createdAt: 'DESC', id: 'ASC' },
      ...(take !== undefined ? { take } : {}),
      ...(skip !== undefined ? { skip } : {}),
    });
  }

  /**
   * UMA promocao da vitrine, por id.
   *
   * Existe porque a tela de detalhe do app (promotion/[id].tsx) resolvia isso
   * baixando TODAS as promocoes ativas e fazendo `.find(p => p.id === id)` no
   * cliente. Alem do desperdicio, isso travava a paginacao desta lista: assim que
   * `activePromotions` ganhasse limite, a tela de detalhe pararia de achar as
   * promocoes fora da primeira pagina.
   *
   * O mesmo predicado da vitrine e aplicado aqui de proposito: promocao expirada
   * ou nao paga continua invisivel, exatamente como antes (o `.find` no cliente
   * tambem nao a encontraria). Devolve null em vez de lancar — a tela ja tem o
   * seu proprio estado de "promocao nao encontrada".
   */
  async findActiveById(id: string): Promise<Promotion | null> {
    const now = new Date();
    return this.promotionsRepository.findOne({
      where: { id, ...PromotionsService.vitrineWhere(now) },
      relations: ['store', 'product'],
    });
  }

  async findByOwner(ownerId: string): Promise<Promotion[]> {
    return this.promotionsRepository.find({
      where: { store: { owner: { id: ownerId } } },
      relations: ['store', 'product'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByStore(storeId: string): Promise<Promotion[]> {
    return this.promotionsRepository.find({
      where: { store: { id: storeId } },
      relations: ['store', 'product'],
      order: { createdAt: 'DESC' },
    });
  }

  async findAll(): Promise<Promotion[]> {
    return this.promotionsRepository.find({
      relations: ['store', 'store.owner', 'product'],
      order: { createdAt: 'DESC' },
    });
  }

  async toggleActive(id: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findOne({
      where: { id },
      relations: ['product'],
    });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    promotion.isActive = !promotion.isActive;
    const saved = await this.promotionsRepository.save(promotion);

    // BL#4: manter o preço promocional do produto em sincronia com o estado da
    // promoção. ANTES, desativar uma promoção PAGA não removia o
    // `promotionalPrice` do produto — o desconto continuava valendo em CADA novo
    // pedido até a data de fim (o pricing lê `product.promotionalPrice` direto,
    // sem checar `isActive`). Agora ao desativar limpamos; ao reativar dentro da
    // vigência reaplicamos (mesmo padrão de delete/swapProduct/markAsPaid).
    if (promotion.isPaid && promotion.product && promotion.promotionalPrice) {
      if (!promotion.isActive) {
        await this.productsRepository.update(promotion.product.id, { promotionalPrice: null as any });
      } else {
        const now = new Date();
        if (now >= new Date(promotion.startDate) && now <= new Date(promotion.endDate)) {
          await this.productsRepository.update(promotion.product.id, {
            promotionalPrice: promotion.promotionalPrice,
          });
        }
      }
    }

    this.publishPromotionUpdate(saved);
    return saved;
  }

  async markAsPaid(id: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findOne({
      where: { id },
      relations: ['product', 'product.store', 'store', 'store.owner'],
    });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    promotion.isPaid = true;
    const saved = await this.promotionsRepository.save(promotion);
    this.publishPromotionUpdate(saved);

    if (promotion.store?.owner?.phone) {
      this.whatsAppService.notifyPromotionPaid(promotion.store.owner.phone, promotion.title).catch(() => {});
    }

    // KAN-12: os clientes FIÉIS da loja sao avisados da campanha.
    //
    // Aqui e nao no createPromotion de propósito: campanha nao paga pode nunca
    // entrar no ar, e avisar sobre oferta que nao existe queima o canal — o
    // cliente aprende a ignorar as notificacoes da loja, e aí nem a oferta boa
    // chega. O service tem teto de destinatarios pelo mesmo motivo.
    if (promotion.store?.id) {
      this.fidelidadeService
        .avisarClientesFieis(
          promotion.store.id,
          `Oferta em ${promotion.store.name || 'uma loja que voce curte'}`,
          promotion.promotionalPrice
            ? `${promotion.title} — agora por R$ ${Number(promotion.promotionalPrice).toFixed(2)}`
            : promotion.title,
          { promotionId: promotion.id },
        )
        .catch(() => {});
    }

    if (promotion.product && promotion.promotionalPrice) {
      const now = new Date();
      const start = new Date(promotion.startDate);
      const end = new Date(promotion.endDate);
      if (now >= start && now <= end) {
        await this.productsRepository.update(promotion.product.id, {
          promotionalPrice: promotion.promotionalPrice,
        });
        this.logger.log(`Applied promotionalPrice ${promotion.promotionalPrice} to product ${promotion.product.id}`);
        const updatedProduct = await this.productsRepository.findOne({
          where: { id: promotion.product.id },
          relations: ['category', 'store'],
        });
        if (updatedProduct) {
          this.pubSub.publish('productUpdated', { productUpdated: updatedProduct });
        }
      }
    }
    return saved;
  }

  async swapProduct(id: string, productId: string, promotionalPrice: number, title: string, userId: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner', 'product'],
    });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    if (promotion.store.owner.id !== userId) {
      throw new BadRequestException('Voce nao e o dono dessa promocao.');
    }
    if (promotion.product && promotion.isPaid) {
      await this.productsRepository.update(promotion.product.id, { promotionalPrice: null as any });
    }
    const product = await this.productsRepository.findOne({
      where: { id: productId, store: { id: promotion.store.id } },
    });
    if (!product) throw new NotFoundException('Produto nao encontrado nessa loja.');
    // BUGFIX: faltava o piso (o create valida `<= 0`). Sem ele, um preco
    // promocional NEGATIVO passava (—5 < preco) e virava preco unitario negativo
    // no pedido (subtotal negativo). Mesmo guard do create.
    if (promotionalPrice <= 0) {
      throw new BadRequestException('O preco promocional deve ser maior que zero.');
    }
    if (promotionalPrice >= Number(product.price)) {
      throw new BadRequestException('O preco promocional deve ser menor que o preco original do produto.');
    }
    promotion.product = product;
    promotion.promotionalPrice = promotionalPrice;
    promotion.title = title;
    if (product.imageUrl) promotion.imageUrl = product.imageUrl;
    const saved = await this.promotionsRepository.save(promotion);
    this.publishPromotionUpdate(saved);
    // BUGFIX: faltavam `isActive` e o inicio da janela. Consequencias: (a) promo
    // comprada para o futuro passava a valer NA HORA (dias de desconto nao
    // pagos); (b) depois de o superadmin DESATIVAR a promocao — o que limpa o
    // preco — bastava o vendedor trocar o produto para o desconto voltar,
    // furando a desativacao. Mesma condicao usada em toggleActive/markAsPaid.
    if (promotion.isPaid && promotion.isActive) {
      const now = new Date();
      const start = new Date(promotion.startDate);
      const end = new Date(promotion.endDate);
      if (now >= start && now <= end) {
        await this.productsRepository.update(product.id, { promotionalPrice });
      }
    }
    return saved;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const promotion = await this.promotionsRepository.findOne({
      where: { id },
      relations: ['store', 'store.owner', 'product'],
    });
    if (!promotion) throw new NotFoundException('Promocao nao encontrada');
    if (promotion.store.owner.id !== userId) {
      throw new BadRequestException('Voce nao e o dono dessa promocao.');
    }
    if (promotion.product && promotion.isPaid) {
      await this.productsRepository.update(promotion.product.id, { promotionalPrice: null as any });
    }
    await this.promotionsRepository.remove(promotion);
    return true;
  }
}
