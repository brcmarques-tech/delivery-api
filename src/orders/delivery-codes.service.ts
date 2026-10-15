import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { randomInt } from 'crypto';
import { Order } from './entities/order.entity';
import { OrderStatus } from '../common/enums';
import { OrdersService } from './orders.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { linhasAfetadas } from '../common/utils/db-claim';

/** Qual das três partes o código pertence. */
export type ParteDoCodigo = 'VENDEDOR' | 'ENTREGADOR' | 'CLIENTE';

const TAMANHO = 6;
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MINUTOS = 15;

/**
 * Garantia de entrega por CÓDIGOS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE CÓDIGO E NÃO BOTÃO
 * ─────────────────────────────────────────────────────────────────────────────
 * Um botão prova apenas que alguém logado naquela conta tocou na tela — não
 * prova presença, não prova entrega, e não serve de evidência em contestação.
 * E a saída que existia para o cliente que não confirmava era pior: auto-confirm
 * por proximidade de GPS depois de 10 minutos. A auditoria encontrou esse vetor
 * sendo explorável com GPS forjado, liberando repasse de pedido nunca entregue.
 *
 * Um código só chega às mãos de quem esteve fisicamente na frente da outra
 * pessoa. É a mesma ideia do código de retirada dos Correios.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O DESENHO
 * ─────────────────────────────────────────────────────────────────────────────
 * Três códigos, um por parte, e a coleta é uma troca MÚTUA:
 *
 *   coleta na loja   → o ENTREGADOR digita o `codigoVendedor`   (esteve lá)
 *                    → o LOJISTA   digita o `codigoEntregador`  (entregou à
 *                                                                pessoa certa)
 *   entrega na porta → o ENTREGADOR digita o `codigoCliente`    (entregou)
 *
 * O terceiro registro LIBERA o dinheiro: dispara o mesmo
 * `completeOrderWithPayment` que o botão do cliente disparava, então a máquina
 * financeira não muda — muda só o que a aciona.
 *
 * A ordem é obrigatória: o código do cliente só é aceito depois do par da
 * coleta. Não existe entregar antes de coletar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O QUE ESTE DESENHO NÃO RESOLVE, E PRECISA SER DITO
 * ─────────────────────────────────────────────────────────────────────────────
 * "O dinheiro sai da plataforma quando os três códigos entram" só é verdade no
 * CARTÃO, onde a pré-autorização é capturada com split no momento da liberação.
 * No PIX o split acontece no pagamento e o vendedor já é creditado ali — nessa
 * forma de pagamento os códigos provam a entrega, mas não seguram o dinheiro.
 * Custódia real no PIX depende de pagar vendedor e entregador fora do Pagar.me
 * (ver KAN-300), porque o provedor não permite a plataforma empurrar dinheiro
 * para um recebedor, e o split é imutável depois do pagamento.
 */
@Injectable()
export class DeliveryCodesService {
  private readonly logger = new Logger(DeliveryCodesService.name);

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @Inject(forwardRef(() => OrdersService))
    private ordersService: OrdersService,
    // O código do cliente é registrado PELO ENTREGADOR, então a confirmação de
    // entrega que já existe (`confirmDelivery`) serve igual: a checagem de posse
    // dela é "esta entrega é sua?", e é. Reaproveitar evita duplicar o registro
    // do `deliveredAt`, a prova de recebimento e o tracking de repasse.
    @Inject(forwardRef(() => DeliveriesService))
    private deliveriesService: DeliveriesService,
  ) {}

  /** Liga/desliga a GERAÇÃO de códigos. Pedido já criado não é afetado. */
  static habilitado(): boolean {
    return (process.env.DELIVERY_CODES_ENABLED ?? 'true') !== 'false';
  }

  /**
   * Um código de 6 dígitos, aleatório de fonte criptográfica.
   *
   * `randomInt` e não `Math.random`: o código é um segredo que autoriza
   * liberação de dinheiro, e `Math.random` é previsível a partir de amostras.
   * Dígitos e não alfanumérico porque o código vai ser falado em voz alta na
   * porta do cliente, muitas vezes com barulho — letra gera confusão
   * (B/V, M/N) e maiúscula/minúscula gera erro de digitação.
   */
  static umCodigo(): string {
    return String(randomInt(0, 1_000_000)).padStart(TAMANHO, '0');
  }

  /**
   * Gera os códigos do LOJISTA e do CLIENTE na criação do pedido.
   *
   * Só para entrega por entregador do app: retirada e frota própria não têm
   * entregador para fazer a troca, e seguem o fluxo antigo. A ausência dos
   * códigos é o que chaveia um fluxo ou outro — por isso pedido em andamento
   * no momento do deploy não quebra.
   */
  static codigosDeNovoPedido(opcoes: {
    isPickup: boolean;
    lojaTemFrotaPropria: boolean;
  }): { codigoVendedor: string; codigoCliente: string } | null {
    if (!DeliveryCodesService.habilitado()) return null;
    if (opcoes.isPickup || opcoes.lojaTemFrotaPropria) return null;
    // Estático de propósito: é chamado de dentro da transação de criação do
    // pedido, em `orders.service`, e injetar o serviço ali só para gerar dois
    // números criaria dependência circular sem necessidade.
    const vendedor = DeliveryCodesService.umCodigo();
    let cliente = DeliveryCodesService.umCodigo();
    while (cliente === vendedor) cliente = DeliveryCodesService.umCodigo();
    return { codigoVendedor: vendedor, codigoCliente: cliente };
  }

  /**
   * Gera o código do ENTREGADOR quando ele aceita a corrida — antes disso não
   * existe entregador para ter código.
   *
   * Claim atômico: só gera se ainda não houver. Duas aceitações concorrentes da
   * mesma corrida (que a camada de entregas já impede, mas defesa em
   * profundidade) não podem produzir dois códigos, senão o lojista digitaria um
   * código válido que não é o do entregador presente.
   */
  async gerarCodigoDoEntregador(orderId: string): Promise<void> {
    if (!DeliveryCodesService.habilitado()) return;
    const pedido = await this.ordersRepository.findOne({
      where: { id: orderId },
      select: ['id', 'codigoVendedor', 'codigoEntregador'],
    });
    // Sem código de vendedor = pedido que não usa o fluxo de códigos
    // (retirada, frota própria, ou anterior à migration).
    if (!pedido?.codigoVendedor) return;

    // Distinto do código da loja, para que uma troca por engano na coleta
    // apareça como erro em vez de passar.
    let codigo = DeliveryCodesService.umCodigo();
    while (codigo === pedido.codigoVendedor) codigo = DeliveryCodesService.umCodigo();

    const claim = await this.ordersRepository.manager.query(
      `UPDATE orders SET "codigoEntregador" = $2
         WHERE id = $1 AND "codigoEntregador" IS NULL
         RETURNING id`,
      [orderId, codigo],
    );
    if (linhasAfetadas(claim) > 0) {
      this.logger.log(`[CODIGO] gerado para o entregador no pedido ${orderId}`);
    }
  }

  /**
   * Libera os pedidos cuja JANELA DE CONTESTAÇÃO venceu sem o cliente
   * contestar.
   *
   * Roda em scheduler. A janela é configurável por
   * `DELIVERY_NO_CODE_DISPUTE_HOURS` (padrão 24h) — e o padrão não é arbitrário:
   * tem de ser longo o suficiente para o cliente ver a notificação e reagir, e
   * curto o suficiente para o entregador não financiar a plataforma.
   *
   * Só libera pedido que:
   *   - tem registro de entrega sem código,
   *   - não teve o código do cliente registrado depois (se teve, já liberou),
   *   - não está em disputa nem em estado terminal.
   *
   * Pedido contestado NÃO entra aqui: ele vira DISPUTED e a decisão é humana,
   * com a foto, o GPS e o horário que o registro guardou.
   */
  async liberarEntregasSemCodigoVencidas(): Promise<number> {
    const horas = Math.max(
      1,
      Number(process.env.DELIVERY_NO_CODE_DISPUTE_HOURS) || 24,
    );
    const limite = new Date(Date.now() - horas * 3600_000);

    const pedidos = await this.ordersRepository.find({
      where: {
        entregaSemCodigoEm: LessThanOrEqual(limite),
        codigoClienteUsadoEm: IsNull(),
        status: In([
          OrderStatus.DELIVERING,
          OrderStatus.DELIVERER_CONFIRMED_DELIVERY,
        ]),
      },
      select: ['id', 'orderNumber'],
    });

    let liberados = 0;
    for (const resumo of pedidos) {
      try {
        const pedido = await this.ordersService.findById(resumo.id);
        const entregaId = (pedido as any).delivery?.id;
        const entregadorId = (pedido as any).delivery?.deliverer?.id;
        if (!entregaId || !entregadorId) continue;

        if (pedido.status === OrderStatus.DELIVERING) {
          await this.deliveriesService.confirmDelivery(
            entregaId,
            entregadorId,
            true,
          );
        }
        const fresco = await this.ordersService.findById(resumo.id);
        await this.ordersService.completeOrderWithPayment(fresco);
        liberados++;
        this.logger.log(
          `[ENTREGA_SEM_CODIGO] pedido #${resumo.orderNumber} liberado — ` +
            `janela de ${horas}h venceu sem contestação`,
        );
      } catch (err: any) {
        this.logger.error(
          `[ENTREGA_SEM_CODIGO] falha ao liberar o pedido #${resumo.orderNumber}: ${err?.message}`,
        );
      }
    }
    return liberados;
  }

  // ───────────────────────────── leitura ─────────────────────────────────

  /**
   * Devolve o código de UMA parte, depois de confirmar que quem pede é aquela
   * parte. Cada chamada entrega um valor só — nunca o pedido inteiro, nunca
   * mais de um código.
   */
  async lerCodigo(
    orderId: string,
    parte: ParteDoCodigo,
    usuarioId: string,
    ehSuperadmin = false,
  ): Promise<string | null> {
    const pedido = await this.ordersRepository.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'delivery', 'delivery.deliverer'],
    });
    if (!pedido) throw new NotFoundException('Pedido não encontrado');

    const dono = this.quemPode(pedido, parte);
    if (!ehSuperadmin && dono !== usuarioId) {
      // Mensagem deliberadamente seca: não confirma nem nega a existência do
      // código nem quem é a parte legítima.
      this.logger.warn(
        `[CODIGO] leitura NEGADA: usuario ${usuarioId} pediu o codigo ${parte} do pedido ${orderId}`,
      );
      throw new ForbiddenException('Você não tem acesso a este código.');
    }

    if (parte === 'VENDEDOR') return pedido.codigoVendedor;
    if (parte === 'ENTREGADOR') return pedido.codigoEntregador;
    return pedido.codigoCliente;
  }

  /**
   * Entrega registrada SEM o código do cliente.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * POR QUE ISTO EXISTE, E POR QUE NÃO É UM BURACO
   * ───────────────────────────────────────────────────────────────────────────
   * Sem uma saída, o pagamento do entregador fica dependendo da boa vontade do
   * cliente: basta ele dormir, não atender, se irritar ou simplesmente se
   * recusar, e o entregador fez a corrida e não recebe. Na percepção dele a
   * culpa é da plataforma, e isso derruba retenção de entregador rápido. O
   * auto-confirm de 10 minutos existia exatamente para evitar esse travamento —
   * só que ele pagava NO ESCURO, sem prova nenhuma, e ainda era forjável por
   * GPS.
   *
   * A troca é: o caminho rápido continua sendo o código (libera na hora); o
   * caminho lento exige EVIDÊNCIA e dá ao cliente o direito de falar.
   *
   *   1. o entregador registra aqui, com foto, GPS e horário;
   *   2. abre uma janela de contestação para o cliente;
   *   3. sem contestação até o fim da janela, libera;
   *   4. com contestação, a plataforma decide com a evidência na mão.
   *
   * A liberação ao fim da janela NÃO acontece aqui — ela é feita pelo scheduler
   * que varre as janelas vencidas. Isto aqui só registra e notifica, para que a
   * decisão e a prova fiquem separadas no tempo e auditáveis.
   *
   * Exige a coleta confirmada pelos dois códigos: sem passar na loja não há
   * entrega para alegar.
   */
  async registrarEntregaSemCodigo(params: {
    orderId: string;
    delivererId: string;
    motivo: string;
    latitude?: number;
    longitude?: number;
  }): Promise<Order> {
    const pedido = await this.ordersService.findById(params.orderId);

    if (!pedido.codigoVendedor) {
      throw new BadRequestException('Este pedido não usa confirmação por código.');
    }
    const entregadorId = (pedido as any).delivery?.deliverer?.id;
    if (!entregadorId || entregadorId !== params.delivererId) {
      throw new ForbiddenException('Esta entrega não pertence a você.');
    }
    if (!pedido.codigoVendedorUsadoEm || !pedido.codigoEntregadorUsadoEm) {
      throw new BadRequestException(
        'Confirme a coleta na loja pelos dois códigos antes de registrar a entrega.',
      );
    }
    if (pedido.codigoClienteUsadoEm) {
      throw new BadRequestException('Esta entrega já foi confirmada por código.');
    }

    const motivo = String(params.motivo || '').trim().slice(0, 300);
    if (motivo.length < 10) {
      // Motivo é o que a plataforma vai ler numa contestação. "nao atendeu"
      // sozinho não sustenta decisão nenhuma.
      throw new BadRequestException(
        'Descreva o que aconteceu com pelo menos 10 caracteres.',
      );
    }

    // Claim atômico: um registro só, mesmo com dois toques.
    const claim = await this.ordersRepository.manager.query(
      `UPDATE orders
          SET "entregaSemCodigoEm" = now(),
              "entregaSemCodigoMotivo" = $2,
              "codigoClienteLat" = COALESCE($3, "codigoClienteLat"),
              "codigoClienteLng" = COALESCE($4, "codigoClienteLng")
        WHERE id = $1 AND "entregaSemCodigoEm" IS NULL
        RETURNING id`,
      [pedido.id, motivo, params.latitude ?? null, params.longitude ?? null],
    );
    if (linhasAfetadas(claim) === 0) {
      throw new BadRequestException('Esta entrega já foi registrada sem código.');
    }

    this.logger.warn(
      `[ENTREGA_SEM_CODIGO] pedido #${pedido.orderNumber} entregador=${params.delivererId} ` +
        `motivo="${motivo}"` +
        (params.latitude != null ? ` gps=${params.latitude},${params.longitude}` : ' SEM GPS'),
    );

    return this.ordersService.findById(pedido.id);
  }

  /** De quem é o código de cada parte. */
  private quemPode(pedido: Order, parte: ParteDoCodigo): string | undefined {
    if (parte === 'VENDEDOR') return pedido.store?.owner?.id;
    if (parte === 'ENTREGADOR') return (pedido as any).delivery?.deliverer?.id;
    return pedido.customer?.id;
  }

  // ───────────────────────────── registro ────────────────────────────────

  /**
   * Registra um código digitado por quem NÃO é o dono dele.
   *
   * `digitadoPor` é o id de quem está digitando, e a validação é cruzada: o
   * código do lojista só pode ser digitado pelo ENTREGADOR da corrida; o do
   * entregador, só pelo DONO DA LOJA; o do cliente, só pelo ENTREGADOR. Quem
   * digita nunca é quem vê — é isso que faz o código provar presença.
   */
  async registrarCodigo(params: {
    orderId: string;
    parte: ParteDoCodigo;
    codigo: string;
    digitadoPor: string;
    latitude?: number;
    longitude?: number;
  }): Promise<Order> {
    const { orderId, parte, codigo, digitadoPor } = params;

    const pedido = await this.ordersService.findById(orderId);
    if (!pedido.codigoVendedor) {
      throw new BadRequestException(
        'Este pedido não usa confirmação por código.',
      );
    }

    this.conferirQuemDigita(pedido, parte, digitadoPor);
    this.conferirEstado(pedido, parte);
    await this.conferirBloqueio(pedido);

    const esperado = this.codigoEsperado(pedido, parte);
    if (!esperado) {
      throw new BadRequestException('Código ainda não disponível para este pedido.');
    }

    const informado = String(codigo || '').replace(/\D/g, '');
    if (informado !== esperado) {
      await this.registrarTentativaErrada(pedido, parte, digitadoPor);
      // Não diz qual código está errado nem quantos dígitos faltam.
      throw new BadRequestException('Código incorreto.');
    }

    return this.gravarAcerto(pedido, parte, params.latitude, params.longitude);
  }

  /** Quem digita tem de ser a OUTRA parte, nunca a dona do código. */
  private conferirQuemDigita(
    pedido: Order,
    parte: ParteDoCodigo,
    digitadoPor: string,
  ): void {
    const entregadorId = (pedido as any).delivery?.deliverer?.id;
    const lojistaId = pedido.store?.owner?.id;

    const esperado =
      parte === 'ENTREGADOR'
        ? lojistaId // o código do entregador é digitado pelo LOJISTA
        : entregadorId; // os do lojista e do cliente, pelo ENTREGADOR

    if (!esperado || esperado !== digitadoPor) {
      this.logger.warn(
        `[CODIGO] registro NEGADO: usuario ${digitadoPor} tentou registrar o codigo ${parte} do pedido ${pedido.id}`,
      );
      throw new ForbiddenException('Você não pode registrar este código.');
    }
  }

  /**
   * Estado e ORDEM. O código do cliente exige o par da coleta completo — não
   * existe entregar antes de coletar, e sem isso o entregador poderia liberar o
   * dinheiro sem nunca ter passado na loja.
   */
  private conferirEstado(pedido: Order, parte: ParteDoCodigo): void {
    const terminais = [
      OrderStatus.COMPLETED,
      OrderStatus.CANCELLED,
      OrderStatus.REJECTED,
      OrderStatus.EXPIRED,
    ];
    if (terminais.includes(pedido.status)) {
      throw new BadRequestException(
        `Pedido já está ${pedido.status} — não aceita mais códigos.`,
      );
    }

    const jaUsado =
      parte === 'VENDEDOR'
        ? pedido.codigoVendedorUsadoEm
        : parte === 'ENTREGADOR'
          ? pedido.codigoEntregadorUsadoEm
          : pedido.codigoClienteUsadoEm;
    if (jaUsado) {
      throw new BadRequestException('Este código já foi registrado.');
    }

    if (parte === 'CLIENTE') {
      if (!pedido.codigoVendedorUsadoEm || !pedido.codigoEntregadorUsadoEm) {
        throw new BadRequestException(
          'A coleta na loja precisa ser confirmada pelos dois códigos antes da entrega.',
        );
      }
    }
  }

  /** Bloqueio por excesso de tentativas. */
  private async conferirBloqueio(pedido: Order): Promise<void> {
    if (pedido.codigoBloqueadoAte && pedido.codigoBloqueadoAte > new Date()) {
      const faltam = Math.ceil(
        (pedido.codigoBloqueadoAte.getTime() - Date.now()) / 60000,
      );
      throw new BadRequestException(
        `Muitas tentativas incorretas. Tente novamente em ${faltam} minuto(s).`,
      );
    }
  }

  private codigoEsperado(pedido: Order, parte: ParteDoCodigo): string | null {
    if (parte === 'VENDEDOR') return pedido.codigoVendedor;
    if (parte === 'ENTREGADOR') return pedido.codigoEntregador;
    return pedido.codigoCliente;
  }

  private async registrarTentativaErrada(
    pedido: Order,
    parte: ParteDoCodigo,
    digitadoPor: string,
  ): Promise<void> {
    const tentativas = (pedido.codigoTentativas || 0) + 1;
    const bloquear = tentativas >= MAX_TENTATIVAS;
    await this.ordersRepository.update(pedido.id, {
      codigoTentativas: tentativas,
      ...(bloquear
        ? {
            codigoBloqueadoAte: new Date(Date.now() + BLOQUEIO_MINUTOS * 60_000),
            codigoTentativas: 0,
          }
        : {}),
    } as any);

    // Nível ERROR quando bloqueia: tentativa repetida no código que libera
    // dinheiro é evento de segurança, não ruído operacional.
    const log = bloquear ? this.logger.error : this.logger.warn;
    log.call(
      this.logger,
      `[CODIGO_ERRADO] pedido #${pedido.orderNumber} parte=${parte} ` +
        `usuario=${digitadoPor} tentativa=${tentativas}` +
        (bloquear ? ` — BLOQUEADO por ${BLOQUEIO_MINUTOS} min` : ''),
    );
  }

  /**
   * Grava o acerto com claim atômico e, se foi o terceiro, LIBERA o dinheiro.
   *
   * O claim na coluna de "usado em" é o que impede registro duplicado sob
   * concorrência — dois toques rápidos no app não podem contar como dois
   * registros, e principalmente não podem disparar a liberação duas vezes.
   */
  private async gravarAcerto(
    pedido: Order,
    parte: ParteDoCodigo,
    latitude?: number,
    longitude?: number,
  ): Promise<Order> {
    const colunaUso =
      parte === 'VENDEDOR'
        ? 'codigoVendedorUsadoEm'
        : parte === 'ENTREGADOR'
          ? 'codigoEntregadorUsadoEm'
          : 'codigoClienteUsadoEm';

    // GPS só nos dois registros feitos pelo entregador — é a posição DELE que
    // serve de evidência. No código do entregador quem digita é o lojista, e a
    // loja tem endereço fixo e conhecido.
    const colunasGps =
      parte === 'VENDEDOR'
        ? ['codigoVendedorLat', 'codigoVendedorLng']
        : parte === 'CLIENTE'
          ? ['codigoClienteLat', 'codigoClienteLng']
          : null;

    const sets = [`"${colunaUso}" = now()`, `"codigoTentativas" = 0`];
    const valores: any[] = [pedido.id];
    if (colunasGps && latitude != null && longitude != null) {
      valores.push(latitude, longitude);
      sets.push(`"${colunasGps[0]}" = $2`, `"${colunasGps[1]}" = $3`);
    }

    const claim = await this.ordersRepository.manager.query(
      `UPDATE orders SET ${sets.join(', ')}
         WHERE id = $1 AND "${colunaUso}" IS NULL
         RETURNING id`,
      valores,
    );
    if (linhasAfetadas(claim) === 0) {
      throw new BadRequestException('Este código já foi registrado.');
    }

    this.logger.log(
      `[CODIGO_OK] pedido #${pedido.orderNumber} parte=${parte}` +
        (latitude != null ? ` gps=${latitude},${longitude}` : ''),
    );

    const atualizado = await this.ordersService.findById(pedido.id);

    // Par da coleta completo → o pedido está em trânsito.
    if (
      parte !== 'CLIENTE' &&
      atualizado.codigoVendedorUsadoEm &&
      atualizado.codigoEntregadorUsadoEm &&
      atualizado.status !== OrderStatus.DELIVERING
    ) {
      await this.ordersService.marcarColetaPorCodigo(atualizado.id);
      return this.ordersService.findById(pedido.id);
    }

    // Terceiro código → confirma a entrega e LIBERA o dinheiro.
    //
    // Passa por `confirmDelivery` de propósito, em vez de pular direto para a
    // finalização: é ele que grava `deliveredAt`, a prova de recebimento e o
    // tracking de repasse, e é ele que leva o pedido a
    // DELIVERER_CONFIRMED_DELIVERY — que é o único estado de onde
    // `completeOrderWithPayment` aceita finalizar. Aquele guard foi uma correção
    // de segurança (impedia finalizar pedido em disputa ou cancelado), então o
    // caminho novo se encaixa nele em vez de contorná-lo.
    if (parte === 'CLIENTE') {
      const entregaId = (atualizado as any).delivery?.id;
      const entregadorId = (atualizado as any).delivery?.deliverer?.id;
      if (!entregaId || !entregadorId) {
        throw new BadRequestException(
          'Pedido sem entrega atribuída — não é possível confirmar.',
        );
      }
      await this.deliveriesService.confirmDelivery(entregaId, entregadorId, true);

      // PROVA DE RECEBIMENTO. O cliente ter informado o código É a confirmação
      // de recebimento dele — mais forte, inclusive, do que o toque num botão.
      //
      // Isto não é redundância com `codigoClienteUsadoEm`: `customerConfirmedAt`
      // é a coluna que o resto do sistema lê como "o cliente confirmou", e no
      // modelo de custódia é ela que autoriza o repasse. Eu havia esquecido de
      // gravá-la, e o resultado era pedido COMPLETED e LIQUIDADO com a prova
      // nula — exatamente o bug que a auditoria já havia corrigido no caminho da
      // automação por GPS. Numa disputa ou chargeback a plataforma não
      // conseguiria demonstrar quando e como a entrega foi confirmada, tendo já
      // repassado a vendedor e entregador.
      //
      // Claim atômico, pelo mesmo motivo dos outros caminhos: se o cliente
      // confirmar pelo botão no mesmo instante, só um grava.
      await this.ordersService.claimCustomerConfirmation(atualizado.id);

      this.logger.log(
        `[CODIGO_LIBERACAO] pedido #${atualizado.orderNumber} — 3 códigos registrados, liberando repasse`,
      );
      const comEntrega = await this.ordersService.findById(pedido.id);
      return this.ordersService.completeOrderWithPayment(comEntrega);
    }

    return atualizado;
  }
}
