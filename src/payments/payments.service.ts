import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Payment } from './entities/payment.entity';
import { SavedCard } from './entities/saved-card.entity';
import { WebhookEvent } from './entities/webhook-event.entity';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionPlansService } from './subscription-plans.service';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { Store } from '../stores/entities/store.entity';
import { Order } from '../orders/entities/order.entity';
import { Promotion } from '../promotions/entities/promotion.entity';
import { Appointment } from '../appointments/entities/appointment.entity';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { AppUsersService } from '../users/app-users.service';
import { VendorUsersService } from '../users/vendor-users.service';
import { PlatformConfigService } from '../config/platform-config.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VendorPlan, OrderStatus } from '../common/enums';
import { PLAN_CONFIGS } from '../common/plan-config';
import { PubSub } from 'graphql-subscriptions';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { linhasAfetadas } from '../common/utils/db-claim';
// Perf/fuso: a data de antecipacao tem de ser decidida no fuso do NEGOCIO, nao
// em UTC — ver dataDeAntecipacao.
import { businessMinutes, businessToday } from '../common/utils/business-time';

// L5: Centralized descriptor constant
const STATEMENT_DESCRIPTOR = 'BCMTECH';

@Injectable()
export class PaymentsService implements OnModuleDestroy {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly pagarmeBaseUrl = 'https://api.pagar.me/core/v5';
  private readonly pagarmeAuthHeader: string;

  // L7: Format phone for Pagar.me API — handles country code stripping for 12-13 digit numbers
  private formatPhoneForPagarme(phone?: string): { country_code: string; area_code: string; number: string } | null {
    let digits = phone?.replace(/\D/g, '') || '';
    if (digits.length < 10) return null; // need at least DDD + 8 digits
    // Strip leading country code 55 for 12-13 digit numbers (55 + DDD + number)
    if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
      digits = digits.substring(2);
    }
    const areaCode = digits.substring(0, 2);
    const number = digits.substring(2);
    return { country_code: '55', area_code: areaCode, number };
  }

  // M7: Build billing address — Pagar.me V5 requires separate fields (street, number, neighborhood)
  /**
   * Endereço de cobrança no formato que o Pagar.me v5 realmente aceita.
   *
   * ANTES devolvia `street` / `number` / `neighborhood`. Esses campos NÃO
   * existem no address da v5 — ela espera `line_1` (número, rua, bairro),
   * `line_2` (complemento), `zip_code`, `city`, `state` e `country`. O gateway
   * descartava os três em silêncio e o antifraude recebia um endereço com
   * apenas CEP, cidade e estado: score pior e mais recusa legítima, sem
   * nenhum erro visível de nosso lado.
   *
   * `state` é normalizado para a sigla de 2 letras e `country` para ISO de 2 —
   * a v5 rejeita valores maiores.
   */
  private buildBillingAddress(
    order: Order,
    store: Store,
  ): { line_1: string; line_2?: string; zip_code: string; city: string; state: string; country: string } {
    const addr = order.deliveryAddress;
    const customerZip =
      (order as any).customer?.zipCode?.replace(/\D/g, '') ||
      (order as any).deliveryZipCode?.replace(/\D/g, '');

    const siglaEstado = (uf?: string): string => {
      const limpo = (uf || '').trim();
      if (/^[A-Za-z]{2}$/.test(limpo)) return limpo.toUpperCase();
      const porExtenso: Record<string, string> = {
        acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA',
        ceara: 'CE', 'distrito federal': 'DF', 'espirito santo': 'ES',
        goias: 'GO', maranhao: 'MA', 'mato grosso': 'MT',
        'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA',
        paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI',
        'rio de janeiro': 'RJ', 'rio grande do norte': 'RN',
        'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
        'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE',
        tocantins: 'TO',
      };
      const chave = limpo
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
      return porExtenso[chave] || 'RS';
    };

    // line_1 no formato recomendado pela v5: "numero, rua, bairro"
    const montarLinha1 = (num: string, rua: string, bairro: string) =>
      [num, rua, bairro].filter(Boolean).join(', ').substring(0, 256);

    if (addr) {
      const parts = addr.split(',').map((p) => p.trim());
      const street = parts[0] || 'Rua Nao Informada';
      const numberAndNeighborhood = parts[1]?.split('-').map((p) => p.trim()) || [];
      const num = numberAndNeighborhood[0] || 'SN';
      const neighborhood = numberAndNeighborhood[1] || parts[2] || 'Centro';
      return {
        line_1: montarLinha1(num, street, neighborhood),
        zip_code: customerZip || store?.zipCode?.replace(/\D/g, '') || '00000000',
        city: parts[parts.length - 1] || store?.city || 'Nao Informada',
        state: siglaEstado(store?.state),
        country: 'BR',
      };
    }

    // Fallback para o endereço da loja (ex.: retirada no local)
    return {
      line_1: montarLinha1(
        store?.number || 'SN',
        store?.street || 'Rua Nao Informada',
        store?.neighborhood || 'Centro',
      ),
      zip_code: store?.zipCode?.replace(/\D/g, '') || '00000000',
      city: store?.city || 'Nao Informada',
      state: siglaEstado(store?.state),
      country: 'BR',
    };
  }

  constructor(
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    @InjectRepository(SavedCard)
    private savedCardsRepository: Repository<SavedCard>,
    @InjectRepository(WebhookEvent)
    private webhookEventsRepository: Repository<WebhookEvent>,
    @InjectRepository(Subscription)
    private subscriptionsRepository: Repository<Subscription>,
    private configService: ConfigService,
    private httpService: HttpService,
    @Inject(forwardRef(() => AppUsersService))
    private appUsersService: AppUsersService,
    @Inject(forwardRef(() => VendorUsersService))
    private vendorUsersService: VendorUsersService,
    private platformConfigService: PlatformConfigService,
    private whatsAppService: WhatsAppService,
    private notificationsService: NotificationsService,
    private subscriptionPlansService: SubscriptionPlansService,
    @Inject(PUB_SUB) private pubSub: PubSub,
  ) {
    const secretKey = this.configService.get('PAGARME_SECRET_KEY') || '';
    this.pagarmeAuthHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');
  }

  // L4: Properly clean up interval on module destroy
  onModuleDestroy() {
    if (this.webhookCleanupInterval) {
      clearInterval(this.webhookCleanupInterval);
    }
  }

  // ─── Pagar.me HTTP helpers ────────────────────────────────────────────

  private async pagarmePost<T = any>(path: string, body: any, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      'Authorization': this.pagarmeAuthHeader,
      'Content-Type': 'application/json',
    };
    // Error#2: chave de idempotência opcional. O Pagar.me deduplica POSTs com a
    // mesma chave, então re-tentar uma transferência de repasse não paga em dobro.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await this.httpService.axiosRef.post(
      `${this.pagarmeBaseUrl}${path}`,
      body,
      { headers },
    );
    return response.data;
  }

  private async pagarmeGet<T = any>(path: string): Promise<T> {
    const response = await this.httpService.axiosRef.get(
      `${this.pagarmeBaseUrl}${path}`,
      {
        headers: {
          'Authorization': this.pagarmeAuthHeader,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  private async pagarmePut<T = any>(path: string, body: any): Promise<T> {
    const response = await this.httpService.axiosRef.put(
      `${this.pagarmeBaseUrl}${path}`,
      body,
      {
        headers: {
          'Authorization': this.pagarmeAuthHeader,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  private async pagarmePatch<T = any>(path: string, body: any): Promise<T> {
    const response = await this.httpService.axiosRef.patch(
      `${this.pagarmeBaseUrl}${path}`,
      body,
      {
        headers: {
          'Authorization': this.pagarmeAuthHeader,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  private async pagarmeDelete<T = any>(
    path: string,
    body?: any,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Authorization': this.pagarmeAuthHeader,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await this.httpService.axiosRef.delete(
      `${this.pagarmeBaseUrl}${path}`,
      // O DELETE de cobranca aceita corpo — e e por ele que se pede estorno
      // PARCIAL (`{ amount }`). No axios, corpo de DELETE vai em `data`.
      { headers, ...(body !== undefined ? { data: body } : {}) },
    );
    return response.data;
  }

  /**
   * Estorna uma cobranca. Sem `amountCents` estorna o TOTAL; com, estorna so
   * aquele valor (estorno parcial).
   *
   * ──────────────────────────────────────────────────────────────────────────
   * DOIS BUGS GRAVES CONSERTADOS AQUI (provados no sandbox em 15/10/2026)
   * ──────────────────────────────────────────────────────────────────────────
   *
   * 1) A ROTA DE ESTORNO NAO EXISTE. O codigo chamava
   *    `POST /charges/{id}/refund` em QUATRO lugares. Essa rota e da v4. Provado
   *    com uma cobranca REAL e PAGA criada no sandbox:
   *
   *      POST /charges/ch_jdJ0VOSyVSaZzpwx/refund   -> 404 com CORPO VAZIO
   *      POST /charges/ch_.../capture (controle)    -> 404 "Charge not found."
   *
   *    O `/capture` casa a rota e so depois nao acha a cobranca; o `/refund`
   *    nao casa rota nenhuma. Tambem testei `/refunds` e `/cancel`: nao existem.
   *    A forma na v5 e `DELETE /charges/{id}`.
   *
   *    Consequencia: TODO estorno de cobranca capturada falhava — cancelamento
   *    de pedido pago, reembolso de pagamento tardio, devolucao de agendamento e
   *    a sobra do ajuste de peso. O dinheiro ficava na plataforma.
   *
   * 2) HTTP 200 NAO SIGNIFICA QUE ESTORNOU. Esta e a parte que mais importa:
   *    o `DELETE` responde 200 mesmo quando o estorno FALHA, e o resultado real
   *    esta em `last_transaction.status`. Medido:
   *
   *      DELETE logo depois da captura -> 200, charge=paid,
   *        last_transaction.status=failed,
   *        erro "action_forbidden | Valor invalido para estorno."
   *      DELETE ~10s depois           -> 200, charge=canceled,
   *        last_transaction.status=refunded, "Transacao aprovada com sucesso"
   *      DELETE { amount: 100 } de 300 -> 200, charge SEGUE paid (correto: so
   *        parte voltou), last_transaction.status=partial_refunded
   *
   *    A recusa aconteceu logo depois da captura e deixou de acontecer segundos
   *    adiante, mas NAO e um atraso fixo: numa execucao posterior do mesmo
   *    experimento o estorno imediato passou de primeira. Ou seja, e
   *    INTERMITENTE — que e o pior caso, porque nao da para contornar com uma
   *    espera e nao aparece em teste feito uma vez.
   *
   *    Seja qual for a causa (liquidacao do adquirente, concorrencia interna), a
   *    licao e a mesma e nao depende de descobri-la: o 200 nao prova nada, e a
   *    decisao tem de sair de `last_transaction.status`. Quem confiasse no
   *    status HTTP registraria "estornado" sem ter estornado — as vezes.
   *
   *    Lancar nesse caso e de proposito: os chamadores ja sabem reabrir o
   *    settlement e re-tentar (ver `settlementErrors` / `retryFailedSettlements`),
   *    e a janela fecha sozinha em segundos. Re-tentar e seguro justamente porque
   *    so chegamos aqui quando o provedor AFIRMOU que falhou.
   */
  private async estornarCobranca(
    chargeId: string,
    opts?: { amountCents?: number; idempotencyKey?: string },
  ): Promise<void> {
    const parcial = opts?.amountCents !== undefined && opts.amountCents !== null;
    // Total: sem corpo (forma validada no sandbox). Parcial: `{ amount }`.
    const corpo = parcial ? { amount: opts!.amountCents } : undefined;

    const resultado: any = await this.pagarmeDelete(
      `/charges/${chargeId}`,
      corpo,
      opts?.idempotencyKey,
    );

    const statusTransacao = String(resultado?.last_transaction?.status || '').toLowerCase();
    const statusCobranca = String(resultado?.status || '').toLowerCase();

    const estornou =
      statusTransacao === 'refunded' ||
      statusTransacao === 'partial_refunded' ||
      // Se o provedor nao trouxer last_transaction, o status da cobranca ainda
      // resolve o caso total. Nao vale para parcial: ali a cobranca segue "paid".
      (!statusTransacao && (statusCobranca === 'canceled' || statusCobranca === 'refunded'));

    // VOID DE PRE-AUTORIZACAO passa por aqui e passa limpo — medido no sandbox
    // em 15/10/2026 (scripts/provas/experimento-void-preauth.mjs):
    //
    //   DELETE numa pre-auth nao capturada -> HTTP 200
    //     charge.status            = "canceled"
    //     last_transaction.status  = "refunded"
    //
    // Ou seja: o provedor usa a palavra "refunded" mesmo quando nao houve
    // captura e nada de dinheiro se moveu. Eu esperava outra palavra (algo como
    // "voided") e teria escrito uma excecao desnecessaria no helper por causa
    // disso. As duas condicoes acima aceitam o void, entao os dois pontos que
    // anulam pre-auth podem usar este helper sem adaptacao.
    //
    // A outra metade da medicao: anular DUAS vezes, capturar uma cobranca ja
    // anulada e recapturar uma ja capturada respondem HTTP 412 — erro de
    // verdade, que o axios transforma em excecao. Isso delimita o problema do
    // 200-mascarando-falha: ele e do ESTORNO DE COBRANCA PAGA, nao de toda
    // operacao de cobranca.

    if (estornou) return;

    const motivo =
      resultado?.last_transaction?.gateway_response?.errors?.[0]?.message ||
      resultado?.last_transaction?.acquirer_message ||
      `last_transaction.status="${statusTransacao || 'ausente'}" charge.status="${statusCobranca}"`;
    throw new Error(
      `estorno recusado pelo provedor (${parcial ? `parcial ${opts!.amountCents}` : 'total'}): ${motivo}`,
    );
  }

  // ─── Pagar.me error translation ──────────────────────────────────────

  private translatePagarmeError(errorData: any): string {
    if (!errorData?.errors) {
      return errorData?.message || 'Erro ao processar no Pagar.me. Tente novamente.';
    }

    const translations: Record<string, string> = {
      // register_information - individual
      'The document field is required': 'CPF é obrigatório',
      'The name field is required': 'Nome é obrigatório',
      'The email field is required': 'Email é obrigatório',
      'The birthdate field is required': 'Data de nascimento é obrigatória',
      'The monthly_income field is required': 'Renda mensal é obrigatória',
      'The professional_occupation field is required': 'Profissão é obrigatória',
      'The phone_numbers field is required': 'Telefone é obrigatório',
      // register_information - corporation
      'The company_name field is required': 'Razão social é obrigatória',
      'The trading_name field is required': 'Nome fantasia é obrigatório',
      'The annual_revenue field is required': 'Faturamento anual é obrigatório',
      // address
      'The street field is required': 'Rua é obrigatória',
      'The street_number field is required': 'Número é obrigatório',
      'The neighborhood field is required': 'Bairro é obrigatório',
      'The city field is required': 'Cidade é obrigatória',
      'The state field is required': 'Estado é obrigatório',
      'The zip_code field is required': 'CEP é obrigatório',
      // bank account
      'The holder_name field is required': 'Nome do titular é obrigatório',
      'The bank field is required': 'Banco é obrigatório',
      'The branch_number field is required': 'Agência é obrigatória',
      'The account_number field is required': 'Conta é obrigatória',
      'The account_check_digit field is required': 'Dígito da conta é obrigatório',
      // uniqueness
      'External ID must be unique': 'Conta já registrada anteriormente',
    };

    const messages: string[] = [];
    for (const field of Object.keys(errorData.errors)) {
      const fieldErrors = errorData.errors[field];
      if (Array.isArray(fieldErrors)) {
        for (const msg of fieldErrors) {
          const translated = translations[msg];
          if (translated) {
            messages.push(translated);
          } else if (msg.includes('is required')) {
            const fieldName = field.split('.').pop()?.replace(/_/g, ' ') || field;
            messages.push(`Campo "${fieldName}" é obrigatório`);
          } else if (msg.includes('is invalid') || msg.includes('is not valid')) {
            const fieldName = field.split('.').pop()?.replace(/_/g, ' ') || field;
            messages.push(`Campo "${fieldName}" é inválido`);
          } else if (msg.includes('must be unique')) {
            messages.push('Conta já registrada anteriormente');
          } else {
            messages.push(msg);
          }
        }
      }
    }

    return messages.length > 0 ? messages.join('. ') + '.' : 'Erro de validação no Pagar.me.';
  }

  // ─── Recipients (Recebedores) ─────────────────────────────────────────

  async createRecipient(data: {
    code: string;
    name: string;
    email: string;
    document: string;
    type: 'individual' | 'corporation';
    birthdate?: string;
    monthlyIncome?: number;
    professionalOccupation?: string;
    motherName?: string;
    phone: { ddd: string; number: string };
    address: {
      street: string;
      streetNumber: string;
      neighborhood: string;
      city: string;
      state: string;
      zipCode: string;
      complementary?: string;
      referencePoint?: string;
    };
    bankAccount: {
      holderName: string;
      bank: string;
      branchNumber: string;
      branchCheckDigit?: string;
      accountNumber: string;
      accountCheckDigit: string;
      type: 'checking' | 'savings';
    };
    // Corporation fields
    companyName?: string;
    tradingName?: string;
    annualRevenue?: number;
    corporationType?: string;
    foundingDate?: string;
    managingPartners?: Array<{
      name: string;
      email: string;
      document: string;
      motherName?: string;
      birthdate: string;
      monthlyIncome: number;
      professionalOccupation: string;
      selfDeclaredLegalRepresentative: boolean;
      phone: { ddd: string; number: string };
      address: {
        street: string;
        streetNumber: string;
        neighborhood: string;
        city: string;
        state: string;
        zipCode: string;
      };
    }>;
  }): Promise<any> {
    const registerInfo: any = {
      email: data.email,
      document: data.document.replace(/\D/g, ''),
      type: data.type,
      phone_numbers: [
        { ddd: data.phone.ddd, number: data.phone.number, type: 'mobile' },
      ],
    };

    if (data.type === 'individual') {
      registerInfo.name = data.name;
      // Pagar.me expects DD/MM/YYYY format
      const [y, m, d] = (data.birthdate || '').split('-');
      registerInfo.birthdate = y && m && d ? `${d}/${m}/${y}` : data.birthdate;
      registerInfo.monthly_income = data.monthlyIncome || 300000; // R$ 3.000,00 em centavos
      registerInfo.professional_occupation = data.professionalOccupation || 'Autônomo';
      if (data.motherName) registerInfo.mother_name = data.motherName;
      registerInfo.address = {
        street: data.address.street,
        street_number: data.address.streetNumber,
        complementary: data.address.complementary || 'N/A',
        reference_point: data.address.referencePoint || 'N/A',
        neighborhood: data.address.neighborhood,
        city: data.address.city,
        state: data.address.state,
        zip_code: data.address.zipCode.replace(/\D/g, ''),
      };
    } else {
      registerInfo.company_name = data.companyName;
      registerInfo.trading_name = data.tradingName;
      registerInfo.annual_revenue = data.annualRevenue;
      if (data.corporationType) registerInfo.corporation_type = data.corporationType;
      if (data.foundingDate) registerInfo.founding_date = data.foundingDate;
      registerInfo.main_address = {
        street: data.address.street,
        street_number: data.address.streetNumber,
        complementary: data.address.complementary || 'N/A',
        reference_point: data.address.referencePoint || 'N/A',
        neighborhood: data.address.neighborhood,
        city: data.address.city,
        state: data.address.state,
        zip_code: data.address.zipCode.replace(/\D/g, ''),
      };
      if (data.managingPartners) {
        registerInfo.managing_partners = data.managingPartners.map((p) => ({
          name: p.name,
          email: p.email,
          document: p.document.replace(/\D/g, ''),
          type: 'individual',
          mother_name: p.motherName || '',
          birthdate: (() => { const [y2, m2, d2] = (p.birthdate || '').split('-'); return y2 && m2 && d2 ? `${d2}/${m2}/${y2}` : p.birthdate; })(),
          monthly_income: p.monthlyIncome || 300000,
          professional_occupation: p.professionalOccupation || 'Empresário',
          self_declared_legal_representative: p.selfDeclaredLegalRepresentative,
          phone_numbers: [{ ddd: p.phone.ddd, number: p.phone.number, type: 'mobile' }],
          address: {
            street: p.address.street,
            street_number: p.address.streetNumber,
            neighborhood: p.address.neighborhood,
            city: p.address.city,
            state: p.address.state,
            zip_code: p.address.zipCode.replace(/\D/g, ''),
          },
        }));
      }
    }

    const body = {
      code: data.code,
      register_information: registerInfo,
      default_bank_account: {
        holder_name: data.bankAccount.holderName,
        holder_type: data.type,
        holder_document: data.document.replace(/\D/g, ''),
        bank: data.bankAccount.bank,
        branch_number: data.bankAccount.branchNumber,
        ...(data.bankAccount.branchCheckDigit ? { branch_check_digit: data.bankAccount.branchCheckDigit } : {}),
        account_number: data.bankAccount.accountNumber,
        account_check_digit: data.bankAccount.accountCheckDigit,
        type: data.bankAccount.type,
      },
      transfer_settings: {
        transfer_enabled: true,
        transfer_interval: 'daily',
        transfer_day: 0,
      },
      automatic_anticipation_settings: {
        enabled: false,
      },
    };

    try {
      this.logger.log(`Creating recipient: ${data.code}`);
      const result = await this.pagarmePost('/recipients', body);
      this.logger.log(`Recipient created: ${result.id} (code: ${data.code})`);
      return result;
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Failed to create recipient: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(this.translatePagarmeError(errorData));
    }
  }

  async updateRecipient(recipientId: string, data: any): Promise<any> {
    const registerInfo: any = {
      email: data.email,
      document: data.document.replace(/\D/g, ''),
      type: data.type,
      phone_numbers: [
        { ddd: data.phone.ddd, number: data.phone.number, type: 'mobile' },
      ],
    };

    if (data.type === 'individual') {
      registerInfo.name = data.name;
      const [y, m, d] = (data.birthdate || '').split('-');
      registerInfo.birthdate = y && m && d ? `${d}/${m}/${y}` : data.birthdate;
      registerInfo.monthly_income = data.monthlyIncome || 300000;
      registerInfo.professional_occupation = data.professionalOccupation || 'Autônomo';
      if (data.address) {
        registerInfo.address = {
          street: data.address.street,
          street_number: data.address.streetNumber,
          complementary: data.address.complementary || 'N/A',
          reference_point: data.address.referencePoint || 'N/A',
          neighborhood: data.address.neighborhood,
          city: data.address.city,
          state: data.address.state,
          zip_code: data.address.zipCode.replace(/\D/g, ''),
        };
      }
    } else if (data.type === 'corporation') {
      if (data.companyName) registerInfo.company_name = data.companyName;
      if (data.tradingName) registerInfo.trading_name = data.tradingName;
      if (data.annualRevenue) registerInfo.annual_revenue = data.annualRevenue;
      if (data.address) {
        registerInfo.main_address = {
          street: data.address.street,
          street_number: data.address.streetNumber,
          complementary: data.address.complementary || 'N/A',
          reference_point: data.address.referencePoint || 'N/A',
          neighborhood: data.address.neighborhood,
          city: data.address.city,
          state: data.address.state,
          zip_code: data.address.zipCode.replace(/\D/g, ''),
        };
      }
    }

    const body: any = {
      register_information: registerInfo,
      default_bank_account: {
        holder_name: data.bankAccount.holderName,
        holder_type: data.type,
        holder_document: data.document.replace(/\D/g, ''),
        bank: data.bankAccount.bank,
        branch_number: data.bankAccount.branchNumber,
        ...(data.bankAccount.branchCheckDigit ? { branch_check_digit: data.bankAccount.branchCheckDigit } : {}),
        account_number: data.bankAccount.accountNumber,
        account_check_digit: data.bankAccount.accountCheckDigit,
        type: data.bankAccount.type,
      },
    };

    try {
      this.logger.log(`Updating recipient: ${recipientId}`);
      const result = await this.pagarmePut(`/recipients/${recipientId}`, body);
      this.logger.log(`Recipient updated: ${recipientId}`);
      return result;
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Failed to update recipient: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(this.translatePagarmeError(errorData));
    }
  }

  async getRecipient(recipientId: string): Promise<any> {
    return this.pagarmeGet(`/recipients/${recipientId}`);
  }

  // ─── Customers ────────────────────────────────────────────────────────

  private async getOrCreatePagarmeCustomer(user: { name: string; email: string; cpf?: string; phone?: string }): Promise<string | undefined> {
    try {
      const phone = this.formatPhoneForPagarme(user.phone);

      const customerBody: any = {
        name: user.name,
        email: user.email,
        type: 'individual',
        document: user.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        ...(phone ? { phones: { mobile_phone: phone } } : {}),
      };

      const result = await this.pagarmePost('/customers', customerBody);
      return result.id;
    } catch (err: any) {
      this.logger.warn(`Failed to create Pagar.me customer: ${err.response?.data?.message || err.message}`);
      return undefined;
    }
  }

  async ensureCustomer(user: AppUser): Promise<string> {
    if (user.pagarmeCustomerId) return user.pagarmeCustomerId;

    const customerId = await this.getOrCreatePagarmeCustomer(user);
    if (!customerId) throw new BadRequestException('Nao foi possivel criar cliente no Pagar.me');

    await this.appUsersService.updatePagarmeCustomerId(user.id, customerId);
    return customerId;
  }

  // ─── Saved Cards ────────────────────────────────────────────────────

  async saveCard(userId: string, cardToken: string): Promise<SavedCard> {
    const user = await this.appUsersService.findById(userId);
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    const customerId = await this.ensureCustomer(user);

    try {
      const result = await this.pagarmePost(`/customers/${customerId}/cards`, { token: cardToken });
      const card = this.savedCardsRepository.create({
        id: result.id,
        userId,
        lastFourDigits: result.last_four_digits,
        brand: result.brand,
        holderName: result.holder_name,
        expMonth: result.exp_month,
        expYear: result.exp_year,
      });
      return this.savedCardsRepository.save(card);
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Failed to save card: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao salvar cartao');
    }
  }

  async listCards(userId: string): Promise<SavedCard[]> {
    // Primary source: our database
    const localCards = await this.savedCardsRepository.find({ where: { userId } });
    if (localCards.length > 0) return localCards;

    // Fallback: fetch from Pagar.me charges (for cards saved before DB tracking)
    const user = await this.appUsersService.findById(userId);
    if (!user?.pagarmeCustomerId) return [];

    try {
      const result = await this.pagarmeGet(
        `/charges?customer_id=${user.pagarmeCustomerId}&payment_method=credit_card&page=1&size=20`,
      );
      const charges = result.data || result;
      const seen = new Set<string>();
      const cards: SavedCard[] = [];

      for (const charge of (Array.isArray(charges) ? charges : [])) {
        const c = charge.last_transaction?.card;
        if (c?.id && c.status === 'active' && !seen.has(c.id)) {
          seen.add(c.id);
          const card = this.savedCardsRepository.create({
            id: c.id,
            userId,
            lastFourDigits: c.last_four_digits,
            brand: c.brand,
            holderName: c.holder_name,
            expMonth: c.exp_month,
            expYear: c.exp_year,
          });
          cards.push(card);
        }
      }

      // Persist discovered cards so future lookups hit the DB
      if (cards.length > 0) {
        await this.savedCardsRepository.save(cards);
      }
      return cards;
    } catch (err: any) {
      this.logger.warn(`Failed to list cards from charges: ${err.response?.data?.message || err.message}`);
      return [];
    }
  }

  async deleteCard(userId: string, cardId: string): Promise<boolean> {
    const user = await this.appUsersService.findById(userId);
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    // Validate card belongs to user
    const card = await this.savedCardsRepository.findOne({ where: { id: cardId, userId } });
    if (!card) {
      throw new BadRequestException('Cartao nao encontrado na sua conta');
    }

    // Delete from Pagar.me (best-effort) and our DB
    if (user.pagarmeCustomerId) {
      try {
        await this.pagarmeDelete(`/customers/${user.pagarmeCustomerId}/cards/${cardId}`);
      } catch (err: any) {
        this.logger.warn(`Failed to delete card from Pagarme: ${err.response?.data?.message || err.message}`);
      }
    }
    await this.savedCardsRepository.remove(card);
    return true;
  }

  // ─── Direct Charge (saved card) ────────────────────────────────────

  async createOrderDirectCharge(order: Order, customer: AppUser, cardId?: string, cardToken?: string): Promise<{ pagarmeOrderId: string; status: string; chargeId?: string }> {
    const store = order.store;

    const customerId = await this.ensureCustomer(customer);
    const totalCents = Math.round(Number(order.total) * 100);

    const phone = this.formatPhoneForPagarme(customer.phone);

    // Use customer's delivery address for billing, not the store's address
    const billingAddress = this.buildBillingAddress(order, store);

    // Unique code per attempt to avoid Pagar.me duplicate rejection (max 52 chars)
    const uniqueCode = `${order.id}-${Date.now()}`;

    // Pré-autorização: capture: false — segura o limite mas não cobra
    // billing_address: quando card_id é usado, o Pagar.me já tem o billing do cartão salvo
    // quando card_token é usado, o billing veio na tokenização feita pelo app
    const orderBody: any = {
      code: uniqueCode,
      items: [
        {
          amount: totalCents,
          description: `Pedido ${order.orderNumber}`.substring(0, 256),
          quantity: 1,
          code: uniqueCode,
        },
      ],
      customer: {
        id: customerId,
        name: customer.name,
        email: customer.email,
        type: 'individual',
        document: customer.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        ...(phone ? { phones: { mobile_phone: phone } } : {}),
        address: billingAddress,
      },
      payments: [
        {
          payment_method: 'credit_card',
          credit_card: {
            installments: 1,
            statement_descriptor: STATEMENT_DESCRIPTOR,
            capture: false,
            ...(cardToken ? { card_token: cardToken } : { card_id: cardId }),
            card: {
              billing_address: billingAddress,
            },
          },
        },
      ],
      metadata: {
        order_id: order.id,
        order_number: order.orderNumber,
      },
      closed: true,
    };

    try {
      const result = await this.pagarmePost('/orders', orderBody);
      const charge = result.charges?.[0];
      const chargeId = charge?.id;
      const status = charge?.status || result.status || 'pending';
      this.logger.log(
        `Pagar.me pre-auth for ${order.orderNumber} | total: ${order.total} | pagarme_order: ${result.id} | charge: ${chargeId} | status: ${status}`,
      );
      // Detect antifraud reproval: acquirer approved but antifraud blocked
      const antifraudResponse = charge?.last_transaction?.antifraud_response;
      const acquirerMessage = charge?.last_transaction?.acquirer_message || '';
      if (
        (status === 'failed' || status === 'refused' || status === 'canceled') &&
        antifraudResponse?.status === 'reproved' &&
        acquirerMessage.toLowerCase().includes('aprovad')
      ) {
        this.logger.warn(
          `Pagar.me antifraud reproved for ${order.orderNumber} | charge: ${chargeId} | acquirer: "${acquirerMessage}" | antifraud score: ${antifraudResponse.score}`,
        );
        return { pagarmeOrderId: result.id, status: 'antifraud_review', chargeId };
      }
      if (status === 'failed' || status === 'refused' || status === 'canceled') {
        const reason = acquirerMessage || charge?.last_transaction?.gateway_response?.errors?.[0]?.message || 'Pagamento recusado';
        throw new BadRequestException(`Pagamento recusado: ${reason}`);
      }
      return { pagarmeOrderId: result.id, status, chargeId };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me pre-auth failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(
        errorData?.message || 'Erro ao pre-autorizar cartao',
      );
    }
  }

  // ─── Order Checkout (Credit Card via Pagar.me) ─────────────────────────

  // M3: Simplified — uses only payment link (no orphaned Pagar.me order)
  async createOrderCheckout(order: Order, customer: AppUser): Promise<{ checkoutUrl: string; preferenceId: string }> {
    await this.ensureCustomer(customer);

    // No split at payment time — all money goes to platform.
    // Transfers to vendor/deliverer happen after delivery is confirmed.

    const totalCents = Math.round(Number(order.total) * 100);

    try {
      // Create hosted checkout page directly via payment link (no separate order)
      const checkoutUrl = await this.createPaymentLink(order, totalCents, []);

      this.logger.log(
        `Pagar.me payment link created for ${order.orderNumber} | total: ${order.total}`,
      );

      // Use a placeholder preferenceId since we no longer create a separate Pagar.me order
      return { checkoutUrl, preferenceId: `link-${order.id}-${Date.now()}` };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me checkout failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(
        errorData?.message || 'Erro ao criar pagamento no Pagar.me',
      );
    }
  }

  // ─── Order PIX ─────────────────────────────────────────────────────────

  async createOrderPix(order: Order, customer: AppUser): Promise<{ checkoutUrl: string; preferenceId: string; qrCode?: string; qrCodeUrl?: string; settledViaSplit?: boolean }> {
    const store = order.store;
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    const platformRecipientId = this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID');

    this.logger.log(`PIX split check: vendorRecipientId=${vendorRecipientId || 'NULL'} platformRecipientId=${platformRecipientId || 'NULL'} storeOwner=${store?.owner?.email || 'NULL'}`);

    const totalCents = Math.round(Number(order.total) * 100);
    const commissionCents = Math.round((Number(order.commissionAmount) || 0) * 100);
    const deliveryFeeCents = Math.round((Number(order.deliveryFee) || 0) * 100);
    const hasExternalDelivery = !store?.hasOwnDelivery && !order.isPickup && deliveryFeeCents > 0;

    // Split-on-charge (auditoria C1): o repasse antigo via /transfers no settle
    // NUNCA funcionou — na v5 /transfers SACA do saldo do proprio recebedor (que
    // e zero), nao distribui da plataforma pra ele. A distribuicao correta e via
    // SPLIT na cobranca. No PIX o pagamento e imediato, entao o split e definido
    // aqui e o Pagar.me credita o vendedor no saldo dele no momento do pagamento
    // (nunca passa pela conta da plataforma). A protecao "estorno garantido": um
    // /refund da cobranca reverte o split (debita o saldo do vendedor).
    //
    // O ENTREGADOR NAO entra neste split: ele so e conhecido no READY (aceite da
    // corrida), depois do pagamento. A taxa de entrega fica com a plataforma e o
    // repasse ao entregador e feito off-platform (marcado [DELIVERER_PAYABLE] no
    // settle). A parte do VENDEDOR e identica ao fluxo de cartao:
    //   entrega externa: total - comissao - frete
    //   retirada/entrega propria: total - comissao (vendedor fica com o frete)
    const splitRules: any[] = [];
    if (vendorRecipientId && platformRecipientId) {
      let vendorAmount = hasExternalDelivery
        ? totalCents - commissionCents - deliveryFeeCents
        : totalCents - commissionCents;
      if (vendorAmount < 0) vendorAmount = 0;

      if (vendorAmount > 0) {
        splitRules.push({
          amount: vendorAmount,
          recipient_id: vendorRecipientId,
          type: 'flat',
          options: { charge_processing_fee: false, liable: false, charge_remainder_fee: false },
        });
      }

      const platformAmount = totalCents - splitRules.reduce((s, r) => s + r.amount, 0);
      if (platformAmount > 0) {
        splitRules.push({
          amount: platformAmount,
          recipient_id: platformRecipientId,
          type: 'flat',
          options: { charge_processing_fee: true, liable: true, charge_remainder_fee: true },
        });
      } else if (splitRules.length > 0) {
        // Comissao 0% (PREMIUM/ENTERPRISE) em retirada/entrega propria: vendedor
        // fica com 100% e a plataforma com 0. Sem regra de valor zero (o gateway
        // recusa) — a taxa/responsabilidade passam pra regra do vendedor.
        splitRules[0].options = {
          ...splitRules[0].options,
          charge_processing_fee: true,
          liable: true,
          charge_remainder_fee: true,
        };
      }

      const splitSum = splitRules.reduce((s, r) => s + r.amount, 0);
      if (splitSum !== totalCents) {
        this.logger.error(
          `PIX split sum mismatch for order #${order.orderNumber}: sum=${splitSum}, total=${totalCents} — caindo no fallback sem split`,
        );
        splitRules.length = 0; // fallback seguro: cobra sem split (nao bloqueia a venda)
      }
    }

    const splitApplied = splitRules.length > 0;
    if (!splitApplied) {
      this.logger.error(
        `[PIX_NO_SPLIT] Pedido #${order.orderNumber}: cobranca PIX SEM split ` +
          `(vendorRecipient=${vendorRecipientId || 'NULL'} platformRecipient=${platformRecipientId || 'NULL'}). ` +
          `Dinheiro fica 100% na plataforma; repasse ao vendedor precisa ser manual.`,
      );
    }

    const phone = this.formatPhoneForPagarme(customer.phone);

    // Unique code per attempt to avoid Pagar.me duplicate rejection (max 52 chars)
    const uniqueCode = `${order.id}-${Date.now()}`;

    const orderBody: any = {
      code: uniqueCode,
      items: [
        {
          amount: totalCents,
          description: `Pedido ${order.orderNumber} (PIX)`.substring(0, 256),
          quantity: 1,
          code: uniqueCode,
        },
      ],
      customer: {
        name: customer.name,
        email: customer.email,
        type: 'individual',
        document: customer.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        ...(phone ? { phones: { mobile_phone: phone } } : {}),
      },
      payments: [
        {
          payment_method: 'pix',
          pix: {
            expires_in: 1800, // 30 minutes
            additional_information: [
              { name: 'Pedido', value: order.orderNumber },
            ],
          },
          ...(splitApplied ? { split: splitRules } : {}),
        },
      ],
      metadata: {
        order_id: order.id,
        order_number: order.orderNumber,
      },
      closed: true,
    };

    try {
      const result = await this.pagarmePost('/orders', orderBody);

      // Extract PIX data from charge
      const charge = result.charges?.[0];
      const lastTransaction = charge?.last_transaction;
      const qrCode = lastTransaction?.qr_code || '';
      const qrCodeUrl = lastTransaction?.qr_code_url || '';

      this.logger.log(
        `Pagar.me PIX order created for ${order.orderNumber} | total: ${order.total} | pagarme_order: ${result.id} | split: ${splitApplied ? splitRules.map((r) => `${r.recipient_id}:${r.amount}`).join(',') : 'NONE'}`,
      );

      return {
        checkoutUrl: qrCodeUrl || '',
        preferenceId: result.id,
        qrCode,
        qrCodeUrl,
        settledViaSplit: splitApplied,
      };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me PIX order failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(
        errorData?.message || 'Erro ao criar pagamento PIX no Pagar.me',
      );
    }
  }

  // ─── Pre-Auth Capture & Cancel ─────────────────────────────────────────

  // Captura a pré-autorização SEM split — tudo vai pra plataforma.
  // Transfers to vendor/deliverer happen after delivery is confirmed.
  async capturePreAuth(order: Order): Promise<{ status: string }> {
    if (!order.preAuthChargeId) {
      throw new BadRequestException('Pedido nao possui pre-autorizacao');
    }

    const totalCents = Math.round(Number(order.total) * 100);

    try {
      // L11: Add timestamp to code to ensure uniqueness across retries
      const body: any = { amount: totalCents, code: `${order.id.replace(/-/g, '')}-c${Date.now()}` };

      const result = await this.pagarmePost(`/charges/${order.preAuthChargeId}/capture`, body);
      this.logger.log(`Pre-auth captured for order #${order.orderNumber} | charge: ${order.preAuthChargeId} | no split (platform holds funds)`);

      return { status: result.status || 'paid' };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pre-auth capture failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao capturar pagamento');
    }
  }

  // Captura a pré-autorização COM split — distribui para vendor, deliverer e plataforma.
  async captureWithSplit(order: Order): Promise<{ status: string }> {
    if (!order.preAuthChargeId) {
      throw new BadRequestException('Pedido nao possui pre-autorizacao');
    }

    const store = order.store;
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    const platformRecipientId = this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID');

    if (!vendorRecipientId) {
      throw new BadRequestException('Vendedor sem recipient Pagar.me cadastrado');
    }
    if (!platformRecipientId) {
      throw new BadRequestException('Platform recipient ID nao configurado');
    }

    const totalCents = Math.round(Number(order.total) * 100);
    const commissionCents = Math.round((Number(order.commissionAmount) || 0) * 100);
    const deliveryFeeCents = Math.round((Number(order.deliveryFee) || 0) * 100);
    const deliveryCommissionPercent = await this.platformConfigService.getDeliveryCommissionPercent();

    const splitRules: any[] = [];
    let vendorAmount: number;
    // KAN-254 (codigo morto no caminho do dinheiro): `platformAmount` era
    // atribuido em CINCO pontos antes do calculo do residuo — comissao +
    // comissao de entrega, mais a parte do entregador sem recipient, mais a
    // comissao no caminho de retirada, mais o clamp do vendedor negativo, mais
    // o else do vendedor zerado — e TODOS eram mortos: o residuo sobrescrevia a
    // variavel sem condicao nenhuma, e o primeiro LEITOR vem depois dele.
    //
    // Isso e pior do que redundancia: eram cinco formulas aparentes para a
    // fatia da plataforma, nenhuma em uso. Quem fosse corrigir a comissao
    // editaria uma delas e nada mudaria — num arquivo que divide dinheiro de
    // verdade. A regra real e uma so e esta logo depois do bloco: a plataforma
    // leva O QUE SOBRA (e por isso absorve MDR, arredondamento e a
    // responsabilidade do split). Agora ela existe em um unico lugar.

    const hasExternalDelivery = !store?.hasOwnDelivery && !order.isPickup && deliveryFeeCents > 0;

    if (hasExternalDelivery) {
      const delivery = (order as any).delivery;
      const delivererRecipientId = delivery?.deliverer?.pagarmeRecipientId;
      const deliveryCommissionCents = Math.round(deliveryFeeCents * (deliveryCommissionPercent / 100));
      const delivererAmount = deliveryFeeCents - deliveryCommissionCents;

      vendorAmount = totalCents - commissionCents - deliveryFeeCents;

      if (delivererRecipientId && delivererAmount > 0) {
        splitRules.push({
          amount: delivererAmount,
          recipient_id: delivererRecipientId,
          type: 'flat',
          options: { charge_processing_fee: false, liable: false, charge_remainder_fee: false },
        });
      } else {
        // Sem recipient do entregador a parte dele fica com a plataforma —
        // automaticamente, porque a plataforma leva o residuo (nao ha soma a
        // fazer aqui; a linha que somava era morta, ver KAN-254 acima).
        //
        // Isto acontecia em SILENCIO: sem log, sem marca no pedido, sem
        // pendencia registrada, e a captura saia como sucesso. O entregador
        // perdia 100% do ganho de uma entrega ja feita e ninguem — nem ele nem a
        // plataforma — tinha como descobrir depois, porque o split ja foi
        // executado e nao ha retroativo. Marcamos o pedido para que a divida
        // fique rastreavel e possa ser paga manualmente.
        this.logger.error(
          `[DELIVERER_UNPAID] Pedido #${order.orderNumber}: entregador sem recipient no Pagar.me. ` +
            `R$ ${(delivererAmount / 100).toFixed(2)} ficaram com a plataforma e precisam de repasse manual.`,
        );
        this.paymentsRepository.manager
          .getRepository(Order)
          .update(order.id, {
            notes: `${order.notes || ''}\n[DELIVERER_UNPAID] R$ ${(delivererAmount / 100).toFixed(2)} nao repassados ao entregador (sem recipient).`.trim(),
          })
          .catch((err: any) =>
            this.logger.error(`Falha ao marcar DELIVERER_UNPAID: ${err?.message}`),
          );
      }
    } else {
      // Pickup or own delivery — vendor gets total minus commission
      // (a plataforma fica com a comissao por consequencia do residuo)
      vendorAmount = totalCents - commissionCents;
    }

    // Cap vendor at 0 minimum. O que o vendedor nao leva volta para o residuo
    // da plataforma sozinho — nao ha nada a somar aqui.
    if (vendorAmount < 0) vendorAmount = 0;

    if (vendorAmount > 0) {
      splitRules.push({
        amount: vendorAmount,
        recipient_id: vendorRecipientId,
        type: 'flat',
        options: { charge_processing_fee: false, liable: false, charge_remainder_fee: false },
      });
    }

    // A UNICA definicao da fatia da plataforma: o que sobra depois das regras do
    // entregador e do vendedor. Absorve MDR, arredondamento e responsabilidade,
    // e e isso que garante a invariante validada mais abaixo (soma == total).
    const platformAmount =
      totalCents - splitRules.reduce((sum, r) => sum + r.amount, 0);

    if (platformAmount > 0) {
      splitRules.push({
        amount: platformAmount,
        recipient_id: platformRecipientId,
        type: 'flat',
        options: { charge_processing_fee: true, liable: true, charge_remainder_fee: true },
      });
    } else if (splitRules.length > 0) {
      // BUGFIX: com comissao 0% (PREMIUM/ENTERPRISE) em pedido de retirada ou
      // entrega propria, o vendedor fica com 100% e `platformAmount` da 0 —
      // entao a regra da plataforma NAO era adicionada e o split saia SEM
      // ninguem marcado como responsavel (`liable`) nem pagando a taxa da
      // adquirente. Ou o Pagar.me recusa (422) e o pedido entregue nunca e
      // capturado (a plataforma nao recebe NADA), ou aceita e a plataforma paga
      // o MDR do proprio bolso em todo pedido desses.
      // Sem regra de valor zero (que o gateway costuma recusar): as opcoes de
      // taxa/responsabilidade passam para a regra do vendedor.
      const principal = splitRules[0];
      principal.options = {
        ...(principal.options || {}),
        charge_processing_fee: true,
        liable: true,
        charge_remainder_fee: true,
      };
    }

    // Final validation
    const finalSum = splitRules.reduce((sum, r) => sum + r.amount, 0);
    if (finalSum !== totalCents) {
      this.logger.error(`Split sum mismatch for order #${order.orderNumber}: sum=${finalSum}, total=${totalCents}`);
      throw new BadRequestException('Erro no calculo do split');
    }

    try {
      const body = {
        amount: totalCents,
        code: `${order.id.replace(/-/g, '')}-s${Date.now()}`,
        split: splitRules,
      };

      const result = await this.pagarmePost(`/charges/${order.preAuthChargeId}/capture`, body);
      this.logger.log(`Capture-with-split for order #${order.orderNumber} | total: ${totalCents} | splits: ${splitRules.map(r => `${r.recipient_id}:${r.amount}`).join(', ')}`);

      return { status: result.status || 'paid' };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Capture-with-split failed for order #${order.orderNumber}: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao capturar pagamento com split');
    }
  }

  // Cancela a pré-autorização (libera o limite do cartão)
  async cancelPreAuth(order: Order): Promise<void> {
    if (!order.preAuthChargeId) return;

    try {
      // Era `pagarmeDelete` cru, com o resultado descartado. O provedor
      // responde 200 nesta rota mesmo quando recusa a operacao, e o preco de
      // nao olhar recai no CLIENTE: o pedido vira cancelado e o limite do
      // cartao dele segue preso ate a pre-auth caducar, o que leva dias. E ele
      // nao tem a quem recorrer, porque para a plataforma deu tudo certo.
      await this.estornarCobranca(order.preAuthChargeId);
      this.logger.log(`Pre-auth cancelled for order #${order.orderNumber} | charge: ${order.preAuthChargeId}`);
    } catch (err: any) {
      // Aqui chegam DUAS coisas diferentes, e tratar as duas como aviso foi o
      // que escondeu o problema:
      //
      //  - HTTP 412 do provedor: a cobranca ja estava anulada, capturada ou
      //    caducada. E benigno e idempotente — segue sendo warn.
      //  - excecao do `estornarCobranca`: veio 200 mas a anulacao FOI RECUSADA.
      //    Isso e dinheiro preso no cartao do cliente e precisa aparecer no
      //    monitoramento, nao se esconder entre avisos de rotina.
      //
      // Os dois continuam sem interromper o cancelamento do pedido: o pedido
      // cancelou de fato, e nao ter conseguido liberar a pre-auth nao e motivo
      // para desfazer isso. A diferenca e so o quanto o erro grita.
      const recusaDoProvedor = String(err?.message || '').startsWith('estorno recusado');
      if (recusaDoProvedor) {
        this.logger.error(
          `[PREAUTH_NAO_LIBERADA] pedido #${order.orderNumber} | charge ${order.preAuthChargeId} ` +
            `| o limite do cliente pode seguir preso: ${err.message}`,
        );
      } else {
        this.logger.warn(`Pre-auth cancel failed (may already be expired): ${err.response?.data?.message || err.message}`);
      }
    }
  }

  // C1 + C3: Reverse settlement from vendor/deliverer back to platform
  // Used on chargeback or refund of already-completed (settled) orders
  /**
   * @param motivo distingue ESTORNO de CHARGEBACK — a diferenca decide se as
   * transferencias precisam ser revertidas na mao. Ver o bloco do split abaixo.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * ATENCAO: A REVERSAO POR TRANSFERENCIA NAO PODE FUNCIONAR. NAO E BUG DE
   * CODIGO — E LIMITE DO PROVEDOR.
   * ──────────────────────────────────────────────────────────────────────────
   *
   * O codigo abaixo tenta puxar dinheiro de volta do vendedor e do entregador
   * com `POST /transfers { recipient_id: plataforma, source_recipient_id: <quem
   * recebeu> }`. Duas coisas impedem isso, as duas medidas contra o sandbox em
   * 15/10/2026:
   *
   *  1. A rota coletiva `POST /transfers` responde 401 "IP de origem nao
   *     autorizado" — esta atras da allowlist de IP do Pagar.me.
   *  2. Mais grave: NAO EXISTE transferencia de um recebedor para outro, nem da
   *     plataforma para um recebedor. O que existe e
   *     `POST /recipients/{id}/transfers { amount }`, e ela e um SAQUE: tira do
   *     saldo DAQUELE recebedor e manda para a conta bancaria DELE. Provado pelo
   *     registro que ela cria:
   *
   *       { "id": "with_8KeGrY5S1ZuyqanL",   <- prefixo "with" = withdraw
   *         "status": "failed",
   *         "bank_account": { "holder_name": "<titular do recebedor>", ... } }
   *       e a mensagem de erro: "The withdraw could not be created."
   *
   *     Ou seja, `source_recipient_id` nao e campo de nada na v5.
   *
   * CONSEQUENCIA DE NEGOCIO, que precisa de decisao e nao de codigo: num modelo
   * de split, o dinheiro vai direto do adquirente para o vendedor e para o
   * entregador. Quando vem um CHARGEBACK depois disso, a plataforma devolve ao
   * cliente e NAO tem como recuperar o que ja saiu. A mitigacao tem de ser de
   * outra natureza — contestar o chargeback, reter uma reserva por recebedor,
   * descontar de repasses futuros do mesmo vendedor, ou cobrir o prejuizo.
   *
   * O ESTORNO comum (nao chargeback) e diferente e esta OK: estornar a cobranca
   * reverte o split junto, porque o adquirente desfaz a divisao original — e por
   * isso o metodo tem o parametro `motivo` e sai cedo no caso de refund com
   * split.
   *
   * Deixei o codigo no lugar de proposito: ele registra `[REVERSAL_ERRORS]` e
   * restaura as marcas de liquidacao, que e o rastro de que ha dinheiro a
   * recuperar. Remover isso apagaria a unica evidencia do prejuizo.
   */
  async reverseSettlementTransfers(
    order: Order,
    motivo: 'refund' | 'chargeback' = 'refund',
  ): Promise<void> {
    // A guarda era `!order.isSettled`, e esse booleano volta a FALSE quando uma
    // das duas transferencias falha — mesmo com a outra ja efetivada. Entao um
    // chargeback depois de liquidacao PARCIAL saia por aqui sem recuperar o
    // dinheiro que JA tinha saido: a plataforma devolvia 100% ao cliente e
    // perdia o repasse feito. Agora a condicao e "alguma parte saiu de fato".
    const algoSaiu =
      order.isSettled || !!order.vendorSettledAt || !!order.delivererSettledAt;
    if (!algoSaiu) {
      this.logger.log(`No settlement to reverse for order #${order.orderNumber} (not settled)`);
      return;
    }

    // A reversao nao tinha NENHUMA marca de "ja revertido" e era re-executavel.
    // Sequencia real: estorno manual reverte os repasses e cancela o pedido; o
    // cliente ainda abre chargeback no banco (acontece) e o webbook chega com o
    // pedido ja CANCELLED e `isSettled` intacto -> reverte de novo, debitando o
    // lojista duas vezes. Proteger com claim atomico em `isSettled` tambem e
    // semanticamente correto: depois de reverter, o dinheiro nao esta mais
    // repassado.
    const reverseClaim = await this.paymentsRepository.manager.query(
      `UPDATE orders
          SET "isSettled" = false,
              "vendorSettledAt" = NULL,
              "delivererSettledAt" = NULL,
              "updatedAt" = NOW()
        WHERE id = $1
          AND ("isSettled" = true
               OR "vendorSettledAt" IS NOT NULL
               OR "delivererSettledAt" IS NOT NULL)
        RETURNING id, "isSettled" AS estava_liquidado`,
      [order.id],
    );
    if (linhasAfetadas(reverseClaim) === 0) {
      this.logger.log(
        `Settlement reversal already performed for order #${order.orderNumber} — skipping`,
      );
      return;
    }

    // O claim zera as marcas por recebedor, entao guardamos o que ELAS DIZIAM
    // antes: e isso que decide o que precisa voltar. `isSettled` legado (pedidos
    // anteriores a estas colunas) conta como "as duas partes sairam".
    const vendorRecebeu = !!order.vendorSettledAt || order.isSettled;
    const entregadorRecebeu = !!order.delivererSettledAt || order.isSettled;

    // Cartao liquidado via capture-with-split: o estorno na cobranca ja desfaz os
    // splits no proprio Pagar.me, entao nao ha transferencia manual a reverter.
    //
    // CRITICO: a condicao era `preAuthChargeId && capturedAt`, que tambem casava
    // com o caminho do ANTIFRAUDE — ali o Pagar.me captura sozinho (gravando
    // capturedAt) SEM split, e o repasse sai depois por /transfers manual. Nesses
    // pedidos a reversao era pulada: no chargeback a plataforma devolvia 100% ao
    // cliente E perdia o que ja tinha repassado a vendedor/entregador.
    // Agora usa a marca explicita gravada na propria captura com split.
    // ...mas isso so vale para ESTORNO. Este early-return era aplicado tambem ao
    // CHARGEBACK, e sao coisas diferentes: no estorno o Pagar.me desfaz o split
    // da propria cobranca; no chargeback quem paga e quem esta `liable`, e nas
    // regras de split montadas na captura o vendedor e o entregador estao com
    // `liable: false` — so a plataforma esta `liable: true`.
    //
    // Resultado com valores: pedido de R$ 200 no cartao, split de R$ 150 para o
    // lojista, R$ 24 para o entregador e R$ 26 para a plataforma. O cliente
    // contesta no banco 30 dias depois. O adquirente debita os R$ 200 INTEIROS
    // da plataforma (unica liable), a reversao saia por aqui sem fazer nada, e
    // ninguem recuperava os R$ 174 que ficaram com lojista e entregador. Em
    // silencio, em TODO chargeback de cartao liquidado.
    //
    // No chargeback seguimos para a reversao manual via /transfers, o mesmo
    // caminho que o PIX ja usava.
    if (
      motivo === 'refund' &&
      order.settledViaSplit &&
      (order.paymentMethod === 'CREDIT_CARD' || order.paymentMethod === 'PIX')
    ) {
      // Cartao (capture-with-split) e PIX (split-on-charge): o /refund da cobranca
      // desfaz o split no proprio Pagar.me (debita o saldo do vendedor). Nao ha
      // transferencia manual a reverter. Este e o "estorno garantido".
      this.logger.log(`Order #${order.orderNumber} settled via split — refund will reverse splits automatically`);
      return;
    }
    if (
      motivo === 'chargeback' &&
      order.paymentMethod === 'CREDIT_CARD' &&
      order.settledViaSplit
    ) {
      this.logger.error(
        `CHARGEBACK em pedido #${order.orderNumber} liquidado via split — revertendo ` +
          `manualmente: no chargeback o adquirente debita apenas a plataforma ` +
          `(unica liable), entao o split NAO se desfaz sozinho.`,
      );
    }

    // PIX: manual transfer reversal (existing logic)
    const store = order.store;
    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const reversalErrors: string[] = [];

    const totalCents = Math.round(Number(order.total) * 100);
    const commissionCents = Math.round((Number(order.commissionAmount) || 0) * 100);
    const deliveryFeeCents = Math.round((Number(order.deliveryFee) || 0) * 100);
    const deliveryCommissionPercent = await this.platformConfigService.getDeliveryCommissionPercent();

    // Reverse deliverer transfer — so se ele REALMENTE recebeu. Antes a reversao
    // era tentada sempre que houvesse recipient, independente de a transferencia
    // ter dado certo, o que podia debitar quem nunca foi pago.
    if (!store?.hasOwnDelivery && !order.isPickup && deliveryFeeCents > 0 && entregadorRecebeu) {
      const delivery = (order as any).delivery;
      const delivererRecipientId = delivery?.deliverer?.pagarmeRecipientId;
      if (delivererRecipientId) {
        const deliveryCommissionCents = Math.round(deliveryFeeCents * (deliveryCommissionPercent / 100));
        const delivererAmount = deliveryFeeCents - deliveryCommissionCents;
        if (delivererAmount > 0) {
          try {
            await this.pagarmePost('/transfers', {
              amount: delivererAmount,
              recipient_id: this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID'),
              source_recipient_id: delivererRecipientId,
              metadata: {
                order_id: order.id,
                order_number: order.orderNumber,
                type: 'chargeback_reversal_deliverer',
              },
            }, `reverse-${order.id}-deliverer`);
            this.logger.log(`Reversed deliverer transfer for order #${order.orderNumber} | amount: ${delivererAmount} cents`);
          } catch (err: any) {
            this.logger.error(`CRITICAL: Failed to reverse deliverer transfer for order #${order.orderNumber}: ${JSON.stringify(err.response?.data || err.message)}`);
            reversalErrors.push(`deliverer_reversal:${delivererAmount}:FAILED`);
          }
        }
      }
    }

    // Reverse vendor transfer
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    if (vendorRecipientId && vendorRecebeu) {
      const platformDeliveryFee = (!store?.hasOwnDelivery && !order.isPickup) ? deliveryFeeCents : 0;
      const vendorAmount = Math.max(0, totalCents - commissionCents - platformDeliveryFee);
      if (vendorAmount > 0) {
        try {
          await this.pagarmePost('/transfers', {
            amount: vendorAmount,
            recipient_id: this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID'),
            source_recipient_id: vendorRecipientId,
            metadata: {
              order_id: order.id,
              order_number: order.orderNumber,
              type: 'chargeback_reversal_vendor',
            },
          }, `reverse-${order.id}-vendor`);
          this.logger.log(`Reversed vendor transfer for order #${order.orderNumber} | amount: ${vendorAmount} cents`);
        } catch (err: any) {
          this.logger.error(`CRITICAL: Failed to reverse vendor transfer for order #${order.orderNumber}: ${JSON.stringify(err.response?.data || err.message)}`);
          reversalErrors.push(`vendor_reversal:${vendorAmount}:FAILED`);
        }
      }
    }

    if (reversalErrors.length > 0) {
      // O claim no topo já zerou isSettled/vendorSettledAt/delivererSettledAt
      // (necessário para a idempotência). Se a reversão FALHOU, isso apagava a
      // única informação de que havia dinheiro repassado — e o `[REVERSAL_ERRORS]`
      // virava uma nota sem nada acionável atrás: nenhum scheduler re-tentava e a
      // perda ficava invisível no balanço.
      //
      // Restaurar as marcas devolve o pedido ao estado "tem repasse a recuperar",
      // que é o que um retry (ou a conferência manual) precisa enxergar. A
      // idempotência segue valendo: quem ganhar o claim de novo tenta de novo, e
      // só zera de vez quando a reversão der certo.
      await orderRepo.update(order.id, {
        notes: `${order.notes || ''}\n[REVERSAL_ERRORS] ${reversalErrors.join(' | ')}`.trim(),
        isSettled: true,
        ...(vendorRecebeu ? { vendorSettledAt: new Date() } : {}),
        ...(entregadorRecebeu ? { delivererSettledAt: new Date() } : {}),
      } as any);
      this.logger.error(
        `[REVERSAL_ERRORS] Pedido #${order.orderNumber}: repasse NAO recuperado — ` +
          `marcas restauradas para permitir nova tentativa/conferencia manual.`,
      );
    }
  }

  // Settle payment after delivery is confirmed.
  // Credit card: capture with split rules (Pagar.me distributes automatically).
  // PIX: manual transfers (balance is instant).
  async settlePayment(order: Order): Promise<void> {
    // C2: Atomic idempotency guard — prevents double settlement
    // ALTO (auditoria 2026-08-23): o claim só olhava `isSettled`. Um settlement em
    // voo do retryFailedSettlements (lista carregada segundos antes) ou a janela
    // entre o findOne do refundOrder e este claim podia repassar vendedor+entregador
    // de um pedido que JÁ tinha sido cancelado/estornado — a plataforma devolvia
    // 100% ao cliente E pagava o repasse (double outflow). Só liquidamos pedido em
    // estado não-terminal-de-cancelamento. DISPUTED PRECISA passar: resolveDispute
    // (DELIVERER_FAVOR) liquida enquanto o pedido ainda está DISPUTED.
    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const settleResult = await orderRepo.manager.query(
      `UPDATE orders SET "isSettled" = true
         WHERE id = $1 AND "isSettled" = false
           AND status NOT IN ('CANCELLED','REJECTED','EXPIRED') RETURNING id`,
      [order.id],
    );
    if (linhasAfetadas(settleResult) === 0) {
      this.logger.warn(`Settlement skipped for order #${order.orderNumber} — already settled or order terminated`);
      return;
    }

    // Credit card with pre-auth still pending: capture with split (Pagar.me distributes automatically)
    // If capturedAt is already set (e.g. antifraud auto-capture), skip to manual transfers below
    if (order.paymentMethod === 'CREDIT_CARD' && order.preAuthChargeId && !order.capturedAt) {
      try {
        await this.captureWithSplit(order);
        // Marca explicitamente que ESTE pedido foi liquidado via split na captura
        // — e o unico caso em que o estorno no Pagar.me desfaz os repasses sozinho.
        await orderRepo.update(order.id, { capturedAt: new Date(), settledViaSplit: true } as any);
        const totalCents = Math.round(Number(order.total) * 100);
        this.logger.log(`Settlement for order #${order.orderNumber} | capture-with-split | total: ${totalCents} cents`);
      } catch (err: any) {
        this.logger.error(`Settlement failed for order #${order.orderNumber}: ${err.message}`);
        // Revert isSettled so it can be retried
        await orderRepo.update(order.id, { isSettled: false } as any);
        throw err;
      }
      return;
    }

    // PIX and other methods: manual transfers (existing logic)
    const store = order.store;
    const vendorRecipientId = store?.owner?.pagarmeRecipientId;
    const totalCents = Math.round(Number(order.total) * 100);
    const commissionCents = Math.round((Number(order.commissionAmount) || 0) * 100);
    const deliveryFeeCents = Math.round((Number(order.deliveryFee) || 0) * 100);

    const deliveryCommissionPercent = await this.platformConfigService.getDeliveryCommissionPercent();

    // Track settlement status on the order
    const settlementErrors: string[] = [];

    // PIX agora usa split-on-charge (C1): vendedor + plataforma JA foram
    // distribuidos pelo Pagar.me no momento do pagamento. Nao repassar de novo via
    // /transfers (que estava quebrado). O entregador nao entrou no split (era
    // desconhecido na cobranca), entao vira um payable off-platform aqui.
    const pixSettledViaSplit = order.paymentMethod === 'PIX' && order.settledViaSplit;

    // 1. Transfer to deliverer (if applicable)
    // `!order.delivererSettledAt`: no retry de uma liquidacao PARCIAL, a parte
    // que ja saiu nao e reenviada. Antes o retry re-postava as duas
    // transferencias a cada rodada de 60s por ate 48h, confiando so no header
    // Idempotency-Key — que nao e comportamento documentado do Pagar.me v5 para
    // /transfers.
    if (!store?.hasOwnDelivery && !order.isPickup && deliveryFeeCents > 0 && !order.delivererSettledAt) {
      const delivery = (order as any).delivery;
      const delivererRecipientId = delivery?.deliverer?.pagarmeRecipientId;
      const deliveryCommissionCents = Math.round(deliveryFeeCents * (deliveryCommissionPercent / 100));
      const delivererAmount = deliveryFeeCents - deliveryCommissionCents;

      if (pixSettledViaSplit) {
        // PIX split-on-charge: o frete ficou com a plataforma (entregador nao
        // estava no split da cobranca). Registra o payable para repasse manual/
        // off-platform e marca como resolvido para nao re-tentar o /transfers.
        if (delivererAmount > 0) {
          await orderRepo.update(order.id, {
            delivererSettledAt: new Date(),
            // Alem da nota legivel, grava o valor em coluna propria: e o que torna
            // o passivo somavel, filtravel e baixavel pelo superadmin.
            delivererPayableCents: delivererAmount,
            notes: `${order.notes || ''}\n[DELIVERER_PAYABLE] R$ ${(delivererAmount / 100).toFixed(2)} a repassar ao entregador (PIX split-on-charge; frete retido na plataforma).`.trim(),
          } as any);
          order.delivererSettledAt = new Date();
          this.logger.log(`[DELIVERER_PAYABLE] order #${order.orderNumber} | ${delivererAmount} cents (off-platform)`);
        }
      } else if (delivererRecipientId) {
        if (delivererAmount > 0) {
          try {
            const result = await this.pagarmePost('/transfers', {
              amount: delivererAmount,
              recipient_id: delivererRecipientId,
              metadata: {
                order_id: order.id,
                order_number: order.orderNumber,
                type: 'delivery_fee',
              },
            }, `settle-${order.id}-deliverer`);
            this.logger.log(`Transfer to deliverer for order #${order.orderNumber} | amount: ${delivererAmount} cents | transfer: ${result.id}`);
            await orderRepo.update(order.id, { delivererSettledAt: new Date() } as any);
            order.delivererSettledAt = new Date();
          } catch (err: any) {
            const errorDetail = JSON.stringify(err.response?.data || err.message);

            if (PaymentsService.ehBloqueioDeOrigem(err)) {
              // Bloqueio de origem (allowlist de IP do Pagar.me). Re-tentar não
              // resolve: a causa é configuração NOSSA, não uma indisponibilidade
              // do provedor. Então o valor vira PASSIVO rastreável — mesmo
              // tratamento do PIX com split-on-charge, logo acima — em vez de
              // ficar 48h em retry e de o lojista receber, a cada rodada, um
              // aviso de falha que não é problema dele.
              await orderRepo.update(order.id, {
                delivererSettledAt: new Date(),
                delivererPayableCents: delivererAmount,
                notes: `${order.notes || ''}\n[DELIVERER_PAYABLE] R$ ${(delivererAmount / 100).toFixed(2)} a repassar ao entregador (repasse bloqueado: allowlist de IP do Pagar.me).`.trim(),
              } as any);
              order.delivererSettledAt = new Date();
              this.logger.error(
                `[REPASSE_BLOQUEADO] pedido #${order.orderNumber} | entregador | ` +
                  `${delivererAmount} centavos viraram passivo. Liberar o IP de saída no ` +
                  `allowlist do Pagar.me (mesmo bloqueio da antecipação).`,
              );
            } else {
              this.logger.error(`Transfer to deliverer failed for order #${order.orderNumber}: ${errorDetail}`);
              settlementErrors.push(`deliverer:${delivererAmount}:${errorDetail}`);
              this.notificationsService.sendToVendorUser(
                store.owner?.id,
                'Falha na transferência',
                `Transferência para entregador do pedido #${order.orderNumber} falhou (R$ ${(delivererAmount / 100).toFixed(2)}). Verifique no painel.`,
                { type: 'TRANSFER_FAILED', orderId: order.id },
              ).catch(() => {});
            }
          }
        }
      } else {
        this.logger.warn(`No deliverer recipient for order #${order.orderNumber}, skipping deliverer transfer`);
      }
    }

    // 2. Transfer to vendor (idem: nao reenvia se ja saiu)
    if (pixSettledViaSplit) {
      // Vendedor ja recebeu via split na cobranca PIX — nada a repassar.
      this.logger.log(`Vendor already settled via PIX split-on-charge for order #${order.orderNumber}`);
    } else if (vendorRecipientId && !order.vendorSettledAt) {
      const platformDeliveryFee = (!store?.hasOwnDelivery && !order.isPickup) ? deliveryFeeCents : 0;
      const vendorAmount = totalCents - commissionCents - platformDeliveryFee;

      if (vendorAmount > 0) {
        try {
          const result = await this.pagarmePost('/transfers', {
            amount: vendorAmount,
            recipient_id: vendorRecipientId,
            metadata: {
              order_id: order.id,
              order_number: order.orderNumber,
              type: 'vendor_payment',
            },
          }, `settle-${order.id}-vendor`);
          this.logger.log(`Transfer to vendor for order #${order.orderNumber} | amount: ${vendorAmount} cents | transfer: ${result.id}`);
          await orderRepo.update(order.id, { vendorSettledAt: new Date() } as any);
          order.vendorSettledAt = new Date();
        } catch (err: any) {
          const errorDetail = JSON.stringify(err.response?.data || err.message);

          if (PaymentsService.ehBloqueioDeOrigem(err)) {
            // Mesmo raciocínio do entregador: bloqueio de origem é
            // configuração NOSSA e não melhora com repetição, então o valor
            // vira passivo rastreável em vez de ficar 48h em retry.
            //
            // A coluna `vendorPayableCents` veio na migration
            // 1786600000000-AddVendorPayable. Quando este tratamento foi
            // escrito ela não existia e o passivo ficava só no marcador em
            // `notes` — consultável por LIKE, mas não somável. O marcador
            // CONTINUA sendo escrito: ele é o rastro legível de POR QUE o
            // valor ficou retido, e a coluna guarda só quanto.
            //
            // NÃO marco `vendorSettledAt`: diferente do caso do PIX com split
            // (onde o vendedor REALMENTE recebeu), aqui ele não recebeu nada.
            // Marcar como liquidado esconderia a dívida. O custo é que o retry
            // continua tentando — e é por isso que o erro vai como ERROR com
            // marcador próprio, para aparecer no monitoramento.
            await orderRepo.update(order.id, {
              vendorPayableCents: vendorAmount,
              notes: `${order.notes || ''}\n[VENDOR_PAYABLE] R$ ${(vendorAmount / 100).toFixed(2)} a repassar ao vendedor (repasse bloqueado: allowlist de IP do Pagar.me).`.trim(),
            } as any);
            this.logger.error(
              `[REPASSE_BLOQUEADO] pedido #${order.orderNumber} | vendedor | ` +
                `${vendorAmount} centavos pendentes. Liberar o IP de saída no allowlist ` +
                `do Pagar.me (mesmo bloqueio da antecipação).`,
            );
            settlementErrors.push(`vendor_bloqueado:${vendorAmount}`);
          } else {
            this.logger.error(`Transfer to vendor failed for order #${order.orderNumber}: ${errorDetail}`);
            settlementErrors.push(`vendor:${vendorAmount}:${errorDetail}`);
            this.notificationsService.sendToVendorUser(
              store.owner?.id,
              'Falha na transferência',
              `A transferência do pedido #${order.orderNumber} (R$ ${(vendorAmount / 100).toFixed(2)}) falhou. Entre em contato com o suporte.`,
              { type: 'TRANSFER_FAILED', orderId: order.id },
            ).catch(() => {});
          }
        }
      } else {
        // H4: Cap vendor amount at 0 (never negative) and notify vendor
        this.logger.warn(`Vendor amount for order #${order.orderNumber} is ${vendorAmount} cents (zero or negative), skipping transfer`);
        const explanation = `Valor do vendedor zerado: comissao (${commissionCents / 100}) + taxa entrega (${platformDeliveryFee / 100}) >= total (${totalCents / 100})`;
        await orderRepo.update(order.id, {
          notes: `${order.notes || ''}\n[VENDOR_ZERO] ${explanation}`.trim(),
        });
        if (store.owner?.id) {
          this.notificationsService.sendToVendorUser(
            store.owner.id,
            'Transferência zerada',
            `Pedido #${order.orderNumber}: ${explanation}`,
            { type: 'VENDOR_ZERO_AMOUNT', orderId: order.id },
          ).catch(() => {});
        }
      }
    } else {
      this.logger.warn(`No vendor recipient for order #${order.orderNumber}, skipping vendor transfer`);
    }

    // 3. Reembolso parcial ao CLIENTE quando o peso final ficou abaixo do pago.
    // `onlinePaidTotal` so existe se houve ajuste de peso em pedido pago online;
    // se ele e maior que o total final, a diferenca esta em custodia e nao
    // pertence a ninguem alem do cliente — antes ela ficava com a plataforma em
    // silencio. So no ramo manual (PIX/link ja capturado): no cartao pre-auth a
    // captura sai pelo total ja limitado e o excedente da autorizacao e liberado
    // sozinho pelo Pagar.me.
    const pagoCents = Math.round(Number(order.onlinePaidTotal ?? 0) * 100);
    const sobraCents = pagoCents - totalCents;
    if (order.onlinePaidTotal != null && sobraCents > 0 && !order.overpaidRefundedAt) {
      // Mesma guarda atomica dos repasses: claim antes da chamada externa, solta
      // no erro. A Idempotency-Key cobre a janela entre o POST ter efeito no
      // Pagar.me e a resposta se perder.
      const claim = await orderRepo.manager.query(
        `UPDATE orders SET "overpaidRefundedAt" = now()
          WHERE id = $1 AND "overpaidRefundedAt" IS NULL RETURNING id`,
        [order.id],
      );
      if (linhasAfetadas(claim) > 0) {
        try {
          let chargeId: string | null = null;
          if (order.preAuthChargeId) {
            chargeId = order.preAuthChargeId;
          } else if (order.mpPreferenceId && !order.mpPreferenceId.startsWith('link-')) {
            const pagarmeOrder = await this.pagarmeGet(`/orders/${order.mpPreferenceId}`);
            chargeId = pagarmeOrder.charges?.[0]?.id ?? null;
          }
          if (!chargeId) throw new Error('cobranca nao localizada no Pagar.me');

          await this.estornarCobranca(chargeId, {
            amountCents: sobraCents,
            idempotencyKey: `weight-refund-${order.id}`,
          });
          this.logger.log(
            `Partial weight refund for order #${order.orderNumber} | paid: ${pagoCents} | final: ${totalCents} | refunded: ${sobraCents} cents`,
          );
          if (order.customer?.id) {
            this.notificationsService.sendToAppUser(
              order.customer.id,
              'Reembolso parcial a caminho',
              `O peso final do pedido #${order.orderNumber} ficou abaixo do estimado. R$ ${(sobraCents / 100).toFixed(2)} serão devolvidos ao seu meio de pagamento.`,
              { type: 'PARTIAL_REFUND', orderId: order.id },
            ).catch(() => {});
          }
        } catch (err: any) {
          const errorDetail = JSON.stringify(err.response?.data || err.message);
          this.logger.error(`Partial weight refund failed for order #${order.orderNumber}: ${errorDetail}`);
          // Solta o claim para o retry re-tentar. Re-tentar e seguro porque o
          // helper so lanca quando o PROVEDOR afirmou que o estorno falhou (ver
          // estornarCobranca) — nao ha estorno "talvez feito" neste caminho. E a
          // causa mais comum e a janela de poucos segundos apos a captura, que
          // fecha sozinha.
          await orderRepo.update(order.id, { overpaidRefundedAt: null } as any);
          settlementErrors.push(`weight_refund:${sobraCents}:${errorDetail}`);
        }
      }
    }

    // Track failed settlements in order notes for superadmin visibility
    if (settlementErrors.length > 0) {
      // Error#2: reabre o settlement (isSettled=false) para o
      // retryFailedSettlements (KAN-205) re-tentar. ANTES o PIX marcava
      // isSettled=true e engolia a falha da transferência → vendedor nunca pago e
      // nunca re-tentado. Agora é seguro re-tentar porque as transferências usam
      // Idempotency-Key (`settle-<order>-vendor/deliverer`): o Pagar.me deduplica,
      // então a que já deu certo NÃO é paga de novo, só a que falhou é re-tentada.
      await orderRepo.update(order.id, {
        notes: `${order.notes || ''}\n[SETTLEMENT_ERRORS] ${settlementErrors.join(' | ')}`.trim(),
        isSettled: false,
      });
    }

    const deliveryCommissionCents = (!store?.hasOwnDelivery && !order.isPickup)
      ? Math.round(deliveryFeeCents * (deliveryCommissionPercent / 100))
      : 0;
    const platformKeeps = commissionCents + deliveryCommissionCents;
    this.logger.log(`Settlement for order #${order.orderNumber} | platform keeps: ${platformKeeps} cents`);
  }

  // ─── Payment Link (hosted checkout) ────────────────────────────────────

  private async createPaymentLink(order: Order, totalCents: number, splitRules: any[]): Promise<string> {
    const body: any = {
      name: `Pedido ${order.orderNumber}`,
      type: 'order',
      amount: totalCents,
      accepted_payment_methods: ['credit_card', 'pix'],
      payment_settings: {
        credit_card: {
          installments: [{ number: 1, total: totalCents }],
          statement_descriptor: STATEMENT_DESCRIPTOR,
        },
        pix: {
          expires_in: 1800,
        },
      },
      items: [
        {
          description: `Pedido ${order.orderNumber}`.substring(0, 256),
          quantity: 1,
          amount: totalCents,
        },
      ],
      ...(splitRules.length > 0 ? { split: splitRules } : {}),
      metadata: {
        order_id: order.id,
        order_number: order.orderNumber,
      },
    };

    try {
      const result = await this.pagarmePost('/paymentlinks', body);
      return result.url || `https://pagar.me/pay/${result.id}`;
    } catch (err: any) {
      this.logger.error(`Payment link creation failed: ${JSON.stringify(err.response?.data || err.message)}`);
      throw new BadRequestException('Erro ao gerar link de pagamento. Tente novamente.');
    }
  }

  // ─── Plan Upgrade ──────────────────────────────────────────────────────

  async createPlanUpgrade(user: VendorUser, plan: VendorPlan, billingPeriod: string = 'monthly', cardToken?: string, paymentMethod: string = 'credit_card'): Promise<Payment> {
    // M5: Use dynamic config from platformConfigService instead of hardcoded PLAN_CONFIGS
    const planConfig = await this.platformConfigService.getPlanConfig(plan);
    if (!planConfig || planConfig.monthlyPrice === 0) {
      throw new BadRequestException('Plano invalido para upgrade');
    }

    // L6: CUSTOM plan requires contact with sales, cannot self-upgrade
    if (planConfig.isContactSales) {
      throw new BadRequestException('Plano personalizado requer contato com a equipe de vendas.');
    }

    // Validate plan hierarchy: cannot downgrade.
    // PIX é cobrança avulsa por ciclo, então RENOVAR o mesmo plano por PIX é
    // esperado (targetLevel === currentLevel). Só bloqueamos downgrade real; e
    // "mesmo plano" só é bloqueado no cartão (que já renova sozinho).
    const planHierarchy: Record<string, number> = { FREE: 0, PRO: 1, PREMIUM: 2, ENTERPRISE: 3 };
    const currentLevel = planHierarchy[user.vendorPlan || 'FREE'] ?? 0;
    const targetLevel = planHierarchy[plan] ?? 0;
    if (targetLevel < currentLevel) {
      throw new BadRequestException('Nao e possivel fazer downgrade de plano.');
    }
    if (targetLevel === currentLevel && paymentMethod !== 'pix') {
      throw new BadRequestException('Você já possui este plano.');
    }

    if (!user.acceptedSubscriptionTermsAt) {
      throw new BadRequestException('Voce precisa aceitar o contrato de assinatura antes de assinar um plano.');
    }

    if (paymentMethod === 'credit_card' && !cardToken) {
      throw new BadRequestException('Token do cartão é obrigatório para assinatura com cartão.');
    }
    if (!['credit_card', 'pix'].includes(paymentMethod)) {
      throw new BadRequestException('Método de pagamento inválido. Use credit_card ou pix.');
    }
    // PIX exige CPF do cliente (o Pagar.me recusa a cobrança sem documento). Sem
    // isso, o app falhava com um 422 genérico ("Erro ao criar assinatura").
    if (paymentMethod === 'pix' && !user.cpf) {
      throw new BadRequestException('Cadastre seu CPF no perfil para pagar o plano com PIX.');
    }

    const billingMap: Record<string, { price: number; months: number; label: string }> = {
      monthly: { price: planConfig.monthlyPrice, months: 1, label: 'Mensal' },
      quarterly: { price: planConfig.quarterlyPrice, months: 3, label: 'Trimestral' },
      semiannual: { price: planConfig.semiannualPrice, months: 6, label: 'Semestral' },
      annual: { price: planConfig.annualPrice, months: 12, label: 'Anual' },
    };

    const billing = billingMap[billingPeriod] || billingMap.monthly;

    // Calculate badge discount
    let badgeDiscount = 0;
    const stores = await this.storesRepository.find({
      where: { owner: { id: user.id } },
    });
    for (const store of stores) {
      if (store.badgeClaimCount >= 2) {
        const rewards = await this.platformConfigService.getBadgeRewards(store.verificationLevel);
        if (rewards.subscriptionDiscount > badgeDiscount) {
          badgeDiscount = rewards.subscriptionDiscount;
        }
      }
    }
    // O plano no Pagar.me é criado pelo preço CHEIO do período; o desconto de
    // selo é aplicado por assinante via `discounts[].value` (flat, em centavos).
    // Por isso o valor do desconto tem que ser calculado sobre o preço cheio.
    // ANTES: `billing.price` era mutado para o valor já descontado ANTES de
    // calcular o `discounts[].value` (linha do discountCents), que então usava o
    // preço já descontado como base → desconto sub-dimensionado, vendor cobrado a
    // mais TODO ciclo, e o `Payment.amount`/`Subscription.amount` gravado (preço
    // descontado) divergia da cobrança real do Pagar.me.
    const fullPriceCents = Math.round(billing.price * 100);
    const badgeDiscountCents = badgeDiscount > 0
      ? Math.round(fullPriceCents * badgeDiscount / 100)
      : 0;
    if (badgeDiscount > 0) {
      // Preço líquido efetivamente cobrado (cheio − desconto), para os registros locais.
      billing.price = (fullPriceCents - badgeDiscountCents) / 100;
      this.logger.log(`Applied ${badgeDiscount}% badge subscription discount for vendor ${user.id} (full: ${fullPriceCents}c, desconto: ${badgeDiscountCents}c)`);
    }

    const totalCents = Math.round(billing.price * 100);

    // Ensure Pagar.me customer exists
    const customerId = await this.ensurePagarmeCustomer(user);

    // ─── PIX: cobrança AVULSA por ciclo (não é assinatura recorrente) ───
    // O Pagar.me NÃO suporta assinatura recorrente via PIX. O modelo correto (e o
    // que o Bruno confirmou como normal) é: a cada ciclo o vendedor paga um QR PIX
    // novo. Criamos uma cobrança PIX avulsa; ao pagar, o webhook order.paid (ramo
    // metadata.type==='plan_upgrade') concede o plano por `duration_months`. Como
    // não há assinatura no Pagar.me, `pagarmeSubscriptionId` fica null — é assim
    // que o painel sabe que é um plano MANUAL (mostra o aviso de vencimento + botão
    // de gerar PIX de renovação perto do fim).
    if (paymentMethod === 'pix') {
      // code do Pagar.me tem limite (~52 chars). UUID completo + prefixo estoura
      // e dá 422 — encurtamos.
      const uniqueCode = `plan-${user.id.replace(/-/g, '').substring(0, 12)}-${Date.now().toString(36)}`;
      const orderBody: any = {
        code: uniqueCode,
        items: [
          {
            amount: totalCents,
            description: `Plano ${plan} (${billing.label})`.substring(0, 256),
            quantity: 1,
            code: uniqueCode,
          },
        ],
        customer_id: customerId,
        payments: [
          {
            payment_method: 'pix',
            pix: {
              expires_in: 3600, // 1h para pagar
              additional_information: [{ name: 'Plano', value: `${plan} ${billing.label}` }],
            },
          },
        ],
        metadata: {
          type: 'plan_upgrade',
          user_id: user.id,
          plan,
          billing_period: billingPeriod,
          duration_months: String(billing.months),
        },
        closed: true,
      };

      const result = await this.pagarmePost('/orders', orderBody);
      const charge = result.charges?.[0];
      const lastTransaction = charge?.last_transaction;
      const qrCode = lastTransaction?.qr_code || '';
      const qrCodeUrl = lastTransaction?.qr_code_url || '';

      // registra o vínculo do customer (o plano só é concedido no webhook do pagamento)
      await this.paymentsRepository.manager.getRepository(VendorUser).update(user.id, {
        pagarmeCustomerId: customerId,
      });

      const payment = this.paymentsRepository.create({
        type: 'SUBSCRIPTION',
        description: `Plano ${plan} (${billing.label}) via PIX`,
        amount: billing.price,
        status: 'pending',
        pagarmeOrderId: result.id,
        metadata: {
          plan,
          billingPeriod,
          paymentMethod: 'pix',
          durationMonths: billing.months,
          qrCode,
          qrCodeUrl,
          pixExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
        vendorUser: user,
      });
      const saved = await this.paymentsRepository.save(payment);
      // campos transientes p/ o painel exibir o QR
      saved.qrCode = qrCode;
      saved.qrCodeUrl = qrCodeUrl;
      saved.pixExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      this.logger.log(`Plano PIX avulso criado p/ vendor ${user.id}: order ${result.id} (${plan} ${billingPeriod}) | qr ${qrCode ? 'OK' : 'VAZIO'}`);
      return saved;
    }

    // Get the Pagar.me plan ID
    const pagarmePlan = await this.subscriptionPlansService.getPagarmePlan(plan, billingPeriod);
    if (!pagarmePlan) {
      throw new BadRequestException('Plano de assinatura não encontrado. Tente novamente em alguns minutos.');
    }

    // Cancel existing subscription if any
    if (user.pagarmeSubscriptionId) {
      await this.cancelExistingSubscription(user);
    }

    // Build subscription body
    const installmentsCount = paymentMethod === 'credit_card' ? billing.months : 1;
    const subscriptionBody: any = {
      plan_id: pagarmePlan.pagarmePlanId,
      payment_method: paymentMethod,
      customer_id: customerId,
      statement_descriptor: STATEMENT_DESCRIPTOR,
      metadata: {
        type: 'plan_upgrade',
        user_id: user.id,
        plan,
        billing_period: billingPeriod,
        payment_method: paymentMethod,
      },
    };

    if (paymentMethod === 'credit_card') {
      subscriptionBody.card_token = cardToken;
      subscriptionBody.installments = installmentsCount;
    }

    // Apply badge discount as flat discount on the subscription.
    // Usa o desconto calculado sobre o preço CHEIO (badgeDiscountCents), não
    // sobre o preço já descontado — senão o vendor era cobrado a mais.
    if (badgeDiscountCents > 0) {
      subscriptionBody.discounts = [{
        value: badgeDiscountCents,
        discount_type: 'flat',
        cycles: 0, // permanent
      }];
    }

    try {
      const result = await this.pagarmePost('/subscriptions', subscriptionBody);

      // Save local Subscription entity
      const subscription = this.subscriptionsRepository.create({
        pagarmeSubscriptionId: result.id,
        pagarmePlanId: pagarmePlan.pagarmePlanId,
        pagarmeCustomerId: customerId,
        plan,
        billingPeriod,
        status: result.status || 'pending',
        currentPeriodStart: result.current_cycle?.start_at ? new Date(result.current_cycle.start_at) : new Date(),
        currentPeriodEnd: result.current_cycle?.end_at ? new Date(result.current_cycle.end_at) : null,
        amount: billing.price,
        installments: installmentsCount,
        metadata: { badgeDiscount, originalPriceCents: Math.round(planConfig.monthlyPrice * billing.months * 100) },
        vendorUser: user,
      });
      await this.subscriptionsRepository.save(subscription);

      // NÃO concede o plano aqui. Criar a assinatura NÃO é pagamento: em PIX/boleto
      // a primeira fatura nasce pendente, então conceder o plano na criação dava
      // plano premium DE GRAÇA a quem nunca pagava (e não era rebaixado). O plano
      // agora é concedido só no webhook invoice.paid (handleInvoicePaid), o único
      // sinal real de pagamento confirmado — vale igual para cartão, PIX e boleto.
      await this.paymentsRepository.manager.getRepository(VendorUser).update(user.id, {
        pagarmeSubscriptionId: result.id,
        pagarmeCustomerId: customerId,
      });

      // Create payment record
      const payment = this.paymentsRepository.create({
        type: 'SUBSCRIPTION',
        description: `Assinatura ${plan} (${billing.label})`,
        amount: billing.price,
        status: 'pending',
        pagarmeOrderId: result.id,
        pagarmeSubscriptionId: result.id,
        metadata: { plan, billingPeriod, installments: installmentsCount, subscriptionId: subscription.id },
        vendorUser: user,
      });
      const saved = await this.paymentsRepository.save(payment);

      if (user.phone) {
        this.whatsAppService.notifyPlanUpgrade(user.phone, user.name, plan, billing.label).catch(() => {});
      }

      this.logger.log(`Subscription created for vendor ${user.id}: ${result.id} (${plan} ${billingPeriod})`);
      return saved;
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Subscription creation failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException('Erro ao criar assinatura. Verifique os dados do cartão e tente novamente.');
    }
  }

  /**
   * Ensure vendor has a Pagar.me customer record.
   * Creates one if pagarmeCustomerId is null.
   */
  private async ensurePagarmeCustomer(user: VendorUser): Promise<string> {
    if (user.pagarmeCustomerId) return user.pagarmeCustomerId;

    const phone = this.formatPhoneForPagarme(user.phone);
    const body: any = {
      name: user.name,
      email: user.email,
      type: 'individual',
      document: user.cpf?.replace(/\D/g, '') || undefined,
      phones: phone ? { mobile_phone: phone } : undefined,
    };

    try {
      const result = await this.pagarmePost('/customers', body);
      await this.paymentsRepository.manager.getRepository(VendorUser).update(user.id, {
        pagarmeCustomerId: result.id,
      });
      this.logger.log(`Created Pagar.me customer for vendor ${user.id}: ${result.id}`);
      return result.id;
    } catch (err: any) {
      this.logger.error(`Failed to create Pagar.me customer: ${JSON.stringify(err.response?.data || err.message)}`);
      throw new BadRequestException('Erro ao criar cadastro de cliente. Verifique seus dados.');
    }
  }

  /**
   * Cancel existing Pagar.me subscription (graceful — cancel at period end).
   */
  private async cancelExistingSubscription(user: VendorUser): Promise<void> {
    try {
      await this.pagarmeDelete(`/subscriptions/${user.pagarmeSubscriptionId}`);
      this.logger.log(`Canceled previous subscription ${user.pagarmeSubscriptionId} for vendor ${user.id}`);

      // Update local subscription record
      await this.subscriptionsRepository.update(
        { pagarmeSubscriptionId: user.pagarmeSubscriptionId },
        { status: 'canceled', canceledAt: new Date() },
      );
    } catch (err: any) {
      this.logger.warn(`Failed to cancel old subscription ${user.pagarmeSubscriptionId}: ${err.response?.data?.message || err.message}`);
      // Don't block new subscription creation
    }
  }

  // ─── Subscription Management ──────────────────────────────────────────

  /**
   * BUG (encontrado via lint `no-misused-promises`): este metodo usava
   *
   *   return findOne({ status: 'active' }) || findOne({ cancelAtPeriodEnd: true })
   *
   * sem `await`. `findOne()` devolve uma **Promise**, que e SEMPRE truthy —
   * entao o `||` nunca avaliava o lado direito e a segunda consulta era codigo
   * morto. Na pratica: o vendedor que cancelou a assinatura mas ainda esta
   * dentro do periodo pago (`cancelAtPeriodEnd: true`) NAO era encontrado como
   * tendo assinatura, e perdia os beneficios do plano antes da hora.
   *
   * Agora aguarda a primeira consulta e so cai para a segunda se nao houver
   * assinatura ativa — que era a intencao original.
   */
  async getActiveSubscription(vendorId: string): Promise<Subscription | null> {
    const active = await this.subscriptionsRepository.findOne({
      where: {
        vendorUser: { id: vendorId },
        status: 'active',
      },
      relations: ['vendorUser'],
    });
    if (active) return active;

    // A segunda consulta existe para o vendedor que cancelou mas ainda esta
    // DENTRO do periodo pago. Faltava justamente o filtro de periodo: como
    // `cancelVendorSubscription` deixa `cancelAtPeriodEnd = true` para sempre e
    // nada limpa esse flag, uma assinatura cancelada em janeiro e vencida em
    // fevereiro continuava sendo devolvida em julho. O painel exibia "Plano
    // PREMIUM — acesso ate 10/02/2026" para quem hoje e FREE, e
    // `reactivateSubscription` reanimava essa mesma linha morta.
    return this.subscriptionsRepository.findOne({
      where: {
        vendorUser: { id: vendorId },
        cancelAtPeriodEnd: true,
        currentPeriodEnd: MoreThan(new Date()),
      },
      relations: ['vendorUser'],
      order: { createdAt: 'DESC' },
    });
  }

  async cancelVendorSubscription(vendorId: string): Promise<void> {
    const subscription = await this.subscriptionsRepository.findOne({
      where: { vendorUser: { id: vendorId }, status: 'active' },
      relations: ['vendorUser'],
    });
    if (!subscription) {
      throw new BadRequestException('Nenhuma assinatura ativa encontrada.');
    }

    // Cancel at period end (vendor keeps plan until expiry)
    try {
      await this.pagarmeDelete(`/subscriptions/${subscription.pagarmeSubscriptionId}`);
    } catch (err: any) {
      this.logger.error(`Failed to cancel subscription on Pagar.me: ${err.response?.data?.message || err.message}`);
      throw new BadRequestException('Erro ao cancelar assinatura. Tente novamente.');
    }

    subscription.cancelAtPeriodEnd = true;
    subscription.status = 'canceled';
    subscription.canceledAt = new Date();
    await this.subscriptionsRepository.save(subscription);

    this.logger.log(`Vendor ${vendorId} canceled subscription ${subscription.pagarmeSubscriptionId} (cancel at period end)`);
  }

  async updateSubscriptionCard(vendorId: string, cardToken: string): Promise<void> {
    const vendor = await this.vendorUsersService.findById(vendorId);
    if (!vendor?.pagarmeSubscriptionId) {
      throw new BadRequestException('Nenhuma assinatura ativa encontrada.');
    }

    try {
      // CAMINHO CORRIGIDO. Era `PATCH /subscriptions/{id}`, que na v5 responde
      // 405 (a rota existe, mas nao aceita PATCH). Verificado contra o sandbox
      // em 15/10/2026, com id de assinatura inexistente para nao alterar nada:
      //
      //   PATCH /subscriptions/{id}                     -> 405
      //   PATCH /subscriptions/{id}/card                -> 422 "The card_id,
      //                                                    card_token or card
      //                                                    field is required."
      //   PATCH /subscriptions/{id}/card {card_token}   -> 404 "Token not found."
      //
      // O 422 lista os campos aceitos e o 404 de token mostra que a rota
      // realmente valida o token — ou seja, e esta.
      //
      // O que isso causava: o lojista que tentasse trocar o cartao da assinatura
      // recebia "Erro ao atualizar cartao. Verifique os dados e tente novamente."
      // — mensagem que culpa os dados DELE, quando a causa era a rota. E o cartao
      // nunca era trocado, entao a renovacao seguia falhando e ele perdia o plano.
      //
      // `payment_method` nao vai mais: na rota /card ele nao e campo (existe a
      // rota /payment-method para esse caso).
      await this.pagarmePatch(
        `/subscriptions/${vendor.pagarmeSubscriptionId}/card`,
        { card_token: cardToken },
      );
      this.logger.log(`Updated card for subscription ${vendor.pagarmeSubscriptionId}`);
    } catch (err: any) {
      const detalhe = err.response?.data?.message || err.message;
      this.logger.error(`Failed to update subscription card: ${detalhe}`);
      // Repassa a mensagem do provedor quando ela existe: "Token not found" e
      // "cartao recusado" sao coisas diferentes para quem esta na tela, e a
      // mensagem generica mandava o lojista conferir dados que podiam estar
      // corretos.
      throw new BadRequestException(
        detalhe
          ? `Nao foi possivel atualizar o cartao: ${detalhe}`
          : 'Erro ao atualizar cartão. Verifique os dados e tente novamente.',
      );
    }
  }

  async reactivateSubscription(vendorId: string): Promise<void> {
    const subscription = await this.subscriptionsRepository.findOne({
      where: { vendorUser: { id: vendorId }, cancelAtPeriodEnd: true },
      relations: ['vendorUser'],
    });
    if (!subscription) {
      throw new BadRequestException('Nenhuma assinatura pendente de cancelamento encontrada.');
    }

    // Pagar.me doesn't have a native "reactivate" — we need to create a new subscription
    // For now, we just remove the cancelAtPeriodEnd flag if the Pagar.me sub is still active
    try {
      const remoteSub = await this.pagarmeGet(`/subscriptions/${subscription.pagarmeSubscriptionId}`);
      if (remoteSub.status === 'canceled') {
        throw new BadRequestException('A assinatura já foi cancelada no Pagar.me. Crie uma nova assinatura.');
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`Failed to check subscription status: ${err.response?.data?.message || err.message}`);
      throw new BadRequestException('Erro ao verificar status da assinatura.');
    }

    subscription.cancelAtPeriodEnd = false;
    subscription.status = 'active';
    subscription.canceledAt = null;
    await this.subscriptionsRepository.save(subscription);

    this.logger.log(`Vendor ${vendorId} reactivated subscription ${subscription.pagarmeSubscriptionId}`);
  }

  // ─── Promotion Checkout ────────────────────────────────────────────────

  async createPromotionCheckout(promotion: Promotion, user: VendorUser): Promise<Payment> {
    const totalCents = Math.round(Number(promotion.adCost) * 100);

    const body: any = {
      name: `Promoção: ${promotion.title}`,
      type: 'order',
      amount: totalCents,
      accepted_payment_methods: ['credit_card', 'pix'],
      payment_settings: {
        credit_card: {
          installments: [{ number: 1, total: totalCents }],
          statement_descriptor: STATEMENT_DESCRIPTOR,
        },
        pix: {
          expires_in: 86400,
        },
      },
      items: [
        {
          description: `Promoção: ${promotion.title}`.substring(0, 256),
          quantity: 1,
          amount: totalCents,
        },
      ],
      metadata: {
        type: 'promotion',
        promotion_id: promotion.id,
        user_id: user.id,
      },
    };

    try {
      const result = await this.pagarmePost('/paymentlinks', body);
      const checkoutUrl = result.url || `https://pagar.me/pay/${result.id}`;

      const payment = this.paymentsRepository.create({
        type: 'PROMOTION',
        description: `Promoção: ${promotion.title}`,
        amount: Number(promotion.adCost),
        status: 'pending',
        pagarmeOrderId: result.id,
        checkoutUrl,
        metadata: { promotionId: promotion.id },
        vendorUser: user,
      });

      return this.paymentsRepository.save(payment);
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Promotion payment link failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException('Erro ao criar link de pagamento para promoção');
    }
  }

  // ─── Recipient Registration (replaces MP OAuth) ────────────────────────

  private async findExistingRecipientByCpf(cpf: string, excludeUserId: string): Promise<string | null> {
    const cleanCpf = cpf.replace(/\D/g, '');

    // Checar se algum entregador com esse CPF já tem recipient
    const deliverer = await this.appUsersService.findByCpfWithRecipient(cleanCpf);
    if (deliverer && deliverer.id !== excludeUserId && deliverer.pagarmeRecipientId) {
      return deliverer.pagarmeRecipientId;
    }

    // Checar se algum vendedor com esse CPF já tem recipient
    const vendor = await this.vendorUsersService.findByCpfWithRecipient(cleanCpf);
    if (vendor && vendor.id !== excludeUserId && vendor.pagarmeRecipientId) {
      return vendor.pagarmeRecipientId;
    }

    return null;
  }

  async registerVendorRecipient(userId: string, recipientData: any): Promise<{ recipientId: string }> {
    const vendor = await this.vendorUsersService.findById(userId);
    if (!vendor) throw new NotFoundException('Vendedor não encontrado');

    // KAN-209: o CPF do recipient DEVE ser o do proprio usuario logado, nunca um
    // vindo da request. Sem isto, informar o CPF de outra pessoa fazia o
    // findExistingRecipientByCpf achar o recipient dela e updateRecipient
    // sobrescrever a conta bancaria alheia (desvio de repasse / account-takeover).
    const ownCpf = (vendor.cpf || '').replace(/\D/g, '');
    if (!ownCpf) {
      throw new BadRequestException('Cadastre seu CPF no perfil antes de configurar o recebimento.');
    }
    recipientData = { ...recipientData, document: ownCpf };

    // Se já tem recipient, atualiza
    if (vendor.pagarmeRecipientId) {
      await this.updateRecipient(vendor.pagarmeRecipientId, recipientData);
      return { recipientId: vendor.pagarmeRecipientId };
    }

    // Reutilizar recipient se o mesmo CPF já existe em outro papel (ex: entregador)
    const existingRecipientId = await this.findExistingRecipientByCpf(recipientData.document, userId);
    if (existingRecipientId) {
      this.logger.log(`Reusing existing recipient ${existingRecipientId} for vendor ${userId} (same CPF)`);
      await this.updateRecipient(existingRecipientId, recipientData);
      await this.vendorUsersService.updatePagarmeRecipient(userId, existingRecipientId);
      return { recipientId: existingRecipientId };
    }

    try {
      const result = await this.createRecipient({
        ...recipientData,
        code: `vendor_${userId}`,
      });
      await this.vendorUsersService.updatePagarmeRecipient(userId, result.id);
      return { recipientId: result.id };
    } catch (err: any) {
      const errorMsg = JSON.stringify(err.response?.data || err.message || '');
      if (errorMsg.includes('unique') || errorMsg.includes('External ID') || errorMsg.includes('external_id')) {
        this.logger.warn(`Vendor recipient vendor_${userId} already exists on Pagar.me, recovering...`);
        try {
          const existing = await this.pagarmeGet(`/recipients?code=vendor_${userId}`);
          const recipientId = existing?.data?.[0]?.id;
          if (recipientId) {
            await this.vendorUsersService.updatePagarmeRecipient(userId, recipientId);
            await this.updateRecipient(recipientId, recipientData);
            return { recipientId };
          }
        } catch { /* fall through */ }
      }
      throw err;
    }
  }

  async registerDelivererRecipient(userId: string, recipientData: any): Promise<{ recipientId: string }> {
    const deliverer = await this.appUsersService.findById(userId);
    if (!deliverer) throw new NotFoundException('Entregador não encontrado');

    // KAN-209: CPF do recipient sempre o do proprio usuario (ver comentario em
    // registerVendorRecipient). Impede sobrescrever a conta bancaria de terceiro.
    const ownCpf = (deliverer.cpf || '').replace(/\D/g, '');
    if (!ownCpf) {
      throw new BadRequestException('Cadastre seu CPF no perfil antes de configurar o recebimento.');
    }
    recipientData = { ...recipientData, document: ownCpf };

    // Se já tem recipient, atualiza
    if (deliverer.pagarmeRecipientId) {
      await this.updateRecipient(deliverer.pagarmeRecipientId, recipientData);
      return { recipientId: deliverer.pagarmeRecipientId };
    }

    // Reutilizar recipient se o mesmo CPF já existe em outro papel (ex: vendedor)
    const existingRecipientId = await this.findExistingRecipientByCpf(recipientData.document, userId);
    if (existingRecipientId) {
      this.logger.log(`Reusing existing recipient ${existingRecipientId} for deliverer ${userId} (same CPF)`);
      await this.updateRecipient(existingRecipientId, recipientData);
      await this.appUsersService.updatePagarmeRecipient(userId, existingRecipientId);
      return { recipientId: existingRecipientId };
    }

    try {
      const result = await this.createRecipient({
        ...recipientData,
        code: `deliverer_${userId}`,
      });
      await this.appUsersService.updatePagarmeRecipient(userId, result.id);
      return { recipientId: result.id };
    } catch (err: any) {
      const errorMsg = JSON.stringify(err.response?.data || err.message || '');
      if (errorMsg.includes('unique') || errorMsg.includes('External ID') || errorMsg.includes('external_id')) {
        this.logger.warn(`Deliverer recipient deliverer_${userId} already exists on Pagar.me, recovering...`);
        try {
          const existing = await this.pagarmeGet(`/recipients?code=deliverer_${userId}`);
          const recipientId = existing?.data?.[0]?.id;
          if (recipientId) {
            await this.appUsersService.updatePagarmeRecipient(userId, recipientId);
            await this.updateRecipient(recipientId, recipientData);
            return { recipientId };
          }
        } catch { /* fall through */ }
      }
      throw err;
    }
  }

  async disconnectVendor(userId: string): Promise<void> {
    const vendor = await this.vendorUsersService.findById(userId);
    if (vendor?.pagarmeRecipientId) {
      try {
        const balance = await this.getRecipientBalance(vendor.pagarmeRecipientId);
        const pendingTotal = balance.waitingFundsAmount + balance.availableAmount;
        if (pendingTotal > 0) {
          throw new BadRequestException(
            `Você tem R$ ${pendingTotal.toFixed(2)} em saldo (R$ ${balance.availableAmount.toFixed(2)} disponível + R$ ${balance.waitingFundsAmount.toFixed(2)} a receber). Saque ou aguarde antes de desconectar.`,
          );
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        this.logger.error(`Balance check failed during disconnect for vendor ${userId}: ${err}`);
        throw new BadRequestException('Não foi possível verificar seu saldo. Tente novamente mais tarde.');
      }
    }
    await this.vendorUsersService.disconnectPayment(userId);
  }

  async disconnectApp(userId: string): Promise<void> {
    const user = await this.appUsersService.findById(userId);
    if (user?.pagarmeRecipientId) {
      try {
        const balance = await this.getRecipientBalance(user.pagarmeRecipientId);
        const pendingTotal = balance.waitingFundsAmount + balance.availableAmount;
        if (pendingTotal > 0) {
          throw new BadRequestException(
            `Você tem R$ ${pendingTotal.toFixed(2)} em saldo. Saque ou aguarde antes de desconectar.`,
          );
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        this.logger.error(`Balance check failed during disconnect for user ${userId}: ${err}`);
        throw new BadRequestException('Não foi possível verificar seu saldo. Tente novamente mais tarde.');
      }
    }
    await this.appUsersService.disconnectPayment(userId);
  }

  // ─── Webhook ───────────────────────────────────────────────────────────

  // H1: In-memory set kept as fast-path cache; DB is source of truth
  private processedWebhooks = new Set<string>();
  private webhookCleanupInterval = setInterval(() => {
    if (this.processedWebhooks.size > 1000) this.processedWebhooks.clear();
  }, 10 * 60 * 1000);

  async handleWebhook(body: any): Promise<void> {
    const eventType = body.type;
    const data = body.data;

    if (!data) return;

    // H1: Database-backed deduplication for webhook events
    const eventKey = `${eventType}:${data.id}`;
    // Fast-path: check in-memory cache first
    if (this.processedWebhooks.has(eventKey)) {
      this.logger.log(`Webhook duplicate skipped (cache): ${eventKey}`);
      return;
    }
    // DB-level dedup: try to insert; unique constraint prevents duplicates
    try {
      await this.webhookEventsRepository.insert({ eventKey });
    } catch (err: any) {
      // Unique constraint violation means already processed
      if (err?.code === '23505' || err?.message?.includes('duplicate')) {
        this.logger.log(`Webhook duplicate skipped (DB): ${eventKey}`);
        this.processedWebhooks.add(eventKey);
        return;
      }
      // Other DB errors: log but continue processing (fail-open)
      this.logger.warn(`Webhook dedup DB error: ${err.message}`);
    }
    this.processedWebhooks.add(eventKey);

    this.logger.log(`Webhook received: ${eventType} | id: ${data.id}`);

    // A chave de dedup e gravada ANTES dos handlers, e o controller nao envolve
    // esta chamada em try/catch. Sem o bloco abaixo, um handler que lancasse
    // (vendor removido, erro transitorio do TypeORM, payload fora do formato)
    // devolvia 500 ao Pagar.me — que reentrega — e a reentrega batia no dedup e
    // era descartada como "duplicate skipped". Ou seja: o lojista PAGOU, o
    // evento foi confirmado, e o plano nunca foi concedido, sem nenhum log de
    // erro para investigar depois. Agora, se o handler falha, a chave e
    // removida e o erro sobe: a reentrega do Pagar.me volta a ser processada.
    try {
      await this.dispatchWebhook(eventType, data);
    } catch (err: any) {
      this.processedWebhooks.delete(eventKey);
      await this.webhookEventsRepository
        .delete({ eventKey })
        .catch((delErr: any) =>
          this.logger.error(
            `Falha ao liberar a chave de dedup ${eventKey} apos erro no handler — ` +
              `a reentrega deste webhook sera descartada: ${delErr?.message}`,
          ),
        );
      this.logger.error(
        `Erro processando webhook ${eventKey}: ${err?.message}`,
        err?.stack,
      );
      throw err;
    }
  }

  /**
   * `currentPeriodEnd` e nullable e nasce null quando a resposta do Pagar.me nao
   * traz `current_cycle` (tipico de PIX/boleto, cujo ciclo so existe depois do
   * primeiro pagamento). Interpolado direto, chegava ao lojista no WhatsApp como
   * "Proxima cobranca: undefined" e "Voce mantem o acesso ate undefined".
   */
  private dataCiclo(fim: Date | null | undefined): string {
    return fim ? new Date(fim).toLocaleDateString('pt-BR') : 'a definir';
  }

  private async dispatchWebhook(eventType: string, data: any): Promise<void> {
    // Handle order events
    if (eventType === 'order.paid') {
      await this.handleOrderPaid(data);
    } else if (eventType === 'order.payment_failed') {
      await this.handleOrderPaymentFailed(data);
    } else if (eventType === 'order.canceled') {
      await this.handleOrderCanceled(data);
    } else if (eventType === 'charge.paid') {
      await this.handleChargePaid(data);
    } else if (eventType === 'charge.refunded') {
      await this.handleChargeRefunded(data);
    } else if (
      // O nome do evento de contestacao NAO esta confirmado no painel: a doc da
      // v5 cita `charge.chargedback` e ha relato de `chargeback.received`.
      // Escutar so um significaria PERDER TODO CHARGEBACK em silencio — sem
      // reversao de repasse, sem cancelamento, sem nada. Aceitar as variantes e
      // barato: a que nao existir simplesmente nunca dispara.
      eventType === 'charge.chargedback' ||
      eventType === 'charge.chargeback' ||
      eventType.startsWith('chargeback.')
    ) {
      await this.handleChargeChargedback(data);
    } else if (eventType === 'charge.payment_failed') {
      await this.handleOrderPaymentFailed(data);
    } else if (eventType.startsWith('anticipation.')) {
      this.logger.log(`Anticipation event: ${eventType} | id: ${data.id} | status: ${data.status}`);
    } else if (eventType === 'subscription.created') {
      await this.handleSubscriptionCreated(data);
    } else if (eventType === 'subscription.updated') {
      await this.handleSubscriptionUpdated(data);
    } else if (eventType === 'subscription.canceled') {
      await this.handleSubscriptionCanceled(data);
    } else if (eventType === 'invoice.created') {
      this.logger.log(`Invoice created: ${data.id} | subscription: ${data.subscription?.id}`);
    } else if (eventType === 'invoice.paid') {
      await this.handleInvoicePaid(data);
    } else if (eventType === 'invoice.payment_failed') {
      await this.handleInvoicePaymentFailed(data);
    } else if (eventType === 'invoice.canceled') {
      this.logger.log(`Invoice canceled: ${data.id} | subscription: ${data.subscription?.id}`);
    } else {
      // Nao havia ramo final: evento desconhecido era DESCARTADO sem rastro. Se
      // o Pagar.me renomear um evento (ou enviar um que nao mapeamos), o sintoma
      // seria dinheiro ou estado parando de atualizar, sem nenhuma pista no log.
      this.logger.warn(
        `[WEBHOOK_NAO_TRATADO] tipo=${eventType} id=${data?.id} — evento ignorado; se repetir, falta um handler.`,
      );
    }
  }

  // #1/#2/#3: verificação OUT-OF-BAND da cobrança. O corpo do webhook é forjável
  // (endpoint protegido só por Basic Auth, sem assinatura HMAC — o Pagar.me v5 não
  // envia uma). Antes de mover dinheiro (confirmar pagamento, reverter repasse),
  // re-consultamos o Pagar.me, que é a autoridade, e conferimos status (e valor,
  // para os eventos de pagamento).
  //
  // Gated por `VERIFY_WEBHOOK_CHARGE` (default OFF): ligar às cegas poderia
  // rejeitar webhooks legítimos se a semântica de status do Pagar.me divergir do
  // esperado (ex.: pré-autorização de cartão). Ligue em produção depois de validar
  // com cobranças reais do sandbox — mesmo padrão de rollout do REQUIRE_WS_AUTH.
  // Fail-safe: qualquer incerteza (cobrança não encontrada / erro de rede) NÃO
  // confirma → o Pagar.me re-tenta o webhook.
  private async webhookChargeConfirms(
    chargeId: string | null,
    pagarmeOrderId: string | null,
    order: Order,
    acceptableStatuses: string[],
    checkAmount: boolean,
  ): Promise<boolean> {
    if (this.configService.get('VERIFY_WEBHOOK_CHARGE') !== 'true') return true;
    try {
      let charge: any = null;
      if (chargeId) {
        charge = await this.pagarmeGet(`/charges/${chargeId}`);
      } else if (pagarmeOrderId) {
        const pOrder = await this.pagarmeGet(`/orders/${pagarmeOrderId}`);
        charge = pOrder?.charges?.[0];
      }
      if (!charge) {
        this.logger.error(`[VERIFY] cobranca nao encontrada no Pagar.me p/ pedido #${order.orderNumber} — webhook REJEITADO`);
        return false;
      }
      if (!acceptableStatuses.includes(charge.status)) {
        this.logger.error(`[VERIFY] charge status=${charge.status} nao aceito (esperado: ${acceptableStatuses.join('/')}) p/ #${order.orderNumber} — REJEITADO`);
        return false;
      }
      if (checkAmount) {
        const expectedCents = Math.round(Number(order.total) * 100);
        if (Number(charge.amount) !== expectedCents) {
          this.logger.error(`[VERIFY] charge amount ${charge.amount} != total ${expectedCents} p/ #${order.orderNumber} — POSSIVEL FORJA, REJEITADO`);
          return false;
        }
      }
      return true;
    } catch (err: any) {
      this.logger.error(`[VERIFY] falha ao consultar Pagar.me p/ #${order.orderNumber}: ${err.message} — nao confirma (Pagar.me re-tenta)`);
      return false;
    }
  }

  private async handleOrderPaid(data: any): Promise<void> {
    const pagarmeOrderId = data.id;
    const metadata = data.metadata || {};
    const code = data.code || '';

    // Check if it's a plan upgrade
    if (metadata.type === 'plan_upgrade') {
      const payment = await this.paymentsRepository.findOne({
        where: { pagarmeOrderId },
        relations: ['vendorUser'],
      });
      if (payment) {
        payment.status = 'approved';
        await this.paymentsRepository.save(payment);
      }
      if (metadata.user_id && metadata.plan) {
        // BUGFIX (cobranca dupla): se o vendedor tinha assinatura RECORRENTE de
        // cartao ativa e agora pagou o plano por PIX (manual), a sub de cartao
        // seguia cobrando todo ciclo ALEM do plano PIX. O cancelamento so rodava
        // no caminho de cartao (createPlanUpgrade), depois do `return` do ramo
        // PIX. Cancelamos AQUI, ao confirmar o PIX (nao ao gerar o QR — senao o
        // vendedor que desistисse perderia a assinatura). Zera o vinculo para o
        // webhook de cancelamento nao rebaixar (ver handleSubscriptionCanceled).
        const vendor = await this.paymentsRepository.manager
          .getRepository(VendorUser)
          .findOne({ where: { id: metadata.user_id } });
        if (vendor?.pagarmeSubscriptionId) {
          await this.cancelExistingSubscription(vendor);
          await this.paymentsRepository.manager
            .getRepository(VendorUser)
            .update(vendor.id, { pagarmeSubscriptionId: null as any });
        }
        await this.vendorUsersService.updateVendorPlan(
          metadata.user_id,
          metadata.plan as VendorPlan,
          parseInt(metadata.duration_months) || 1,
        );
      }
      return;
    }

    // Check if it's a promotion
    if (metadata.type === 'promotion') {
      const payment = await this.paymentsRepository.findOne({
        where: { pagarmeOrderId },
      });
      if (payment) {
        payment.status = 'approved';
        await this.paymentsRepository.save(payment);
      }
      if (metadata.promotion_id) {
        const promoRepo = this.paymentsRepository.manager.getRepository(Promotion);
        const productRepo = this.paymentsRepository.manager.getRepository('Product');
        const promotion = await promoRepo.findOne({
          where: { id: metadata.promotion_id },
          relations: ['product'],
        });
        if (promotion && !promotion.isPaid) {
          promotion.isPaid = true;
          await promoRepo.save(promotion);
          if (promotion.product && promotion.promotionalPrice) {
            const now = new Date();
            if (now >= new Date(promotion.startDate) && now <= new Date(promotion.endDate)) {
              await productRepo.update(promotion.product.id, {
                promotionalPrice: promotion.promotionalPrice,
              });
            }
          }
        }
      }
      return;
    }

    // Handle appointment payment
    if (metadata.type === 'appointment' && metadata.appointment_id) {
      await this.handleAppointmentPaid(metadata.appointment_id, pagarmeOrderId);
      return;
    }

    // Handle order payment
    const orderId = metadata.order_id || (code ? code.replace(/^([a-f0-9-]{36}).*$/, '$1') : null);
    if (orderId) {
      const orderRepo = this.paymentsRepository.manager.getRepository(Order);
      const order = await orderRepo.findOne({
        where: { id: orderId },
        relations: ['customer', 'store'],
      });

      if (order && (order.status === OrderStatus.AWAITING_PAYMENT || order.status === OrderStatus.PAYMENT_REVIEW)) {
        // #1: verifica a cobrança no Pagar.me antes de confirmar (gated).
        if (!(await this.webhookChargeConfirms(data.charges?.[0]?.id || null, pagarmeOrderId, order, ['paid', 'captured', 'authorized', 'pending_capture'], true))) return;
        // BUGFIX (dinheiro): simétrico ao handleChargePaid. Quando o pedido saiu
        // de PAYMENT_REVIEW (antifraude reprovou mas a adquirente aprovou), o
        // Pagar.me AUTO-CAPTURA a cobrança no reprocessamento. Só o charge.paid
        // marcava capturedAt; se o order.paid chegasse PRIMEIRO, o claim atômico
        // dava a transição a ele (o charge.paid achava PENDING e retornava) e o
        // capturedAt ficava NULL. Na conclusão, settlePayment via
        // CREDIT_CARD+preAuthChargeId+!capturedAt e tentava capturar de novo uma
        // cobrança já capturada → Pagar.me recusa → settlement falha para sempre
        // e vendedor/entregador nunca recebem. Marcamos capturedAt aqui também,
        // qualquer que seja a ordem dos webhooks.
        const wasPaymentReview = order.status === OrderStatus.PAYMENT_REVIEW;
        const setCaptured = wasPaymentReview && !!order.preAuthChargeId && !order.capturedAt;
        // R#4: confirmação ATÔMICA do pagamento. Os webhooks order.paid e
        // charge.paid chegam quase juntos e o dedup é por (evento:id), então NÃO
        // se anulam entre si. ANTES ambos passavam por este ponto (read-check-save)
        // e cada um incrementava o cupom + disparava "Pagamento confirmado". O
        // UPDATE condicional garante que só UM webhook confirma; o outro retorna.
        const newMpPref = (order.mpPreferenceId?.startsWith('link-') && pagarmeOrderId)
          ? pagarmeOrderId
          : order.mpPreferenceId;
        const paidClaim = await orderRepo.manager.query(
          // CRITICO: "updatedAt" = NOW() e OBRIGATORIO aqui. expirePendingOrders
          // usa updatedAt para medir ha quanto tempo o pedido esta PENDING sem a
          // loja aceitar. @UpdateDateColumn so age em save() do TypeORM — SQL cru
          // deixava updatedAt na hora da CRIACAO. Resultado: PIX pago 10+ min
          // depois da criacao virava PENDING ja "vencido" e o scheduler expirava
          // + estornava um pedido recem-pago, dizendo que a loja nao respondeu.
          `UPDATE orders
              SET status = 'PENDING', "couponCredited" = true, "mpPreferenceId" = $2,
                  "updatedAt" = NOW()${setCaptured ? ', "capturedAt" = NOW()' : ''}
            WHERE id = $1 AND status IN ('AWAITING_PAYMENT','PAYMENT_REVIEW')
            RETURNING id`,
          [order.id, newMpPref],
        );
        if (linhasAfetadas(paidClaim) === 0) return;
        order.status = OrderStatus.PENDING;
        order.couponCredited = true;
        order.mpPreferenceId = newMpPref;
        if (setCaptured) {
          order.capturedAt = new Date();
          this.logger.log(`Order.paid (antifraud reprocessed): marking capturedAt for order #${order.orderNumber} — charge was auto-captured by Pagar.me`);
        }
        this.logger.log(`Pagamento aprovado para pedido #${order.orderNumber}`);

        // Re-fetch with full relations so subscription filters can access store.id
        const freshOrder = await orderRepo.findOne({
          where: { id: order.id },
          // store.owner e delivery.deliverer são necessários para o filtro de
          // ownership das subscriptions decidir quem é parte do pedido.
          relations: ['customer', 'store', 'store.owner', 'items', 'items.product', 'delivery', 'delivery.deliverer'],
        });

        // Publish real-time update so app/vendor panel refresh
        if (freshOrder) {
          this.pubSub.publish('orderUpdated', { orderUpdated: freshOrder });
          this.pubSub.publish('orderCreated', { orderCreated: freshOrder });
        }

        // Cupom multi-uso (BUGFIX): a reserva do uso do cupom foi MOVIDA para a
        // criacao do pedido (orders.service.create, dentro da transacao, para
        // todos os metodos). Incrementar aqui de novo, no webhook, gerava DUPLA
        // contagem para pagamento online. O couponCredited ja nasce true na
        // criacao e os fluxos de queda devolvem o uso — nada a fazer aqui.

        // Notify customer
        if (order.customer?.id) {
          this.notificationsService.sendToAppUser(
            order.customer.id,
            'Pagamento confirmado!',
            `Seu pagamento do pedido #${order.orderNumber} foi aprovado. Aguarde a confirmação da loja.`,
            { type: 'PAYMENT_CONFIRMED', orderId: order.id },
          ).catch(() => {});
        }
        if (order.customer?.phone) {
          this.whatsAppService.sendText(
            order.customer.phone,
            `✅ *Pagamento confirmado!*\n\nSeu pagamento do pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) foi aprovado.\n\nAguarde a confirmação da loja!`,
          ).catch(() => {});
        }

        // O lojista NAO era avisado neste ponto — e este e o unico momento em que
        // o pedido passa a ser acionavel por ele. O aviso de "Novo pedido!" sai em
        // createOrder, quando um pedido PIX/cartao ainda esta AWAITING_PAYMENT e
        // pode nunca ser pago. Quando o pagamento entrava minutos depois, nada
        // avisava, e `expirePendingOrders` cancelava e estornava o pedido dizendo
        // que "a loja nao respondeu a tempo". Venda perdida com o lojista
        // convencido de que nunca foi avisado. O claim atomico acima garante que
        // isto rode uma vez so.
        const donoDaLoja = freshOrder?.store?.owner ?? order.store?.owner;
        if (donoDaLoja?.id) {
          this.notificationsService.sendToVendorUser(
            donoDaLoja.id,
            'Pedido pago — aguardando sua confirmação',
            `Pedido #${order.orderNumber} - R$ ${Number(order.total).toFixed(2)}`,
            { type: 'NEW_ORDER', orderId: order.id },
          ).catch(() => {});
        }
        if (donoDaLoja?.phone) {
          this.whatsAppService.sendText(
            donoDaLoja.phone,
            `💰 *Pedido pago!*\n\nO pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) foi pago e aguarda sua confirmação.\n\nAceite pelo painel para não perder a venda.`,
          ).catch(() => {});
        }
      } else if (
        order &&
        [OrderStatus.EXPIRED, OrderStatus.CANCELLED, OrderStatus.REJECTED].includes(
          order.status as OrderStatus,
        )
      ) {
        // PAGAMENTO APOS A EXPIRACAO. expireAwaitingPaymentOrders expira aos 30
        // min SEM estornar (premissa: nao foi pago). Cliente que paga aos 29:59
        // com o webhook chegando aos 30:05 caia aqui — e o codigo retornava em
        // SILENCIO: pedido "expirado", dinheiro com a plataforma, nenhum
        // marcador, nenhuma query capaz de achar o caso. Agora: estorno
        // automatico + marcador.
        await this.refundLatePayment(order, data, orderRepo);
      }
    }
  }

  /**
   * Estorna um pagamento que chegou com o pedido ja terminal (expirado ou
   * cancelado antes do webhook). Claim atomico via marcador em notes:
   * order.paid e charge.paid chegam quase juntos e nao se anulam no dedup
   * (chaves distintas), entao so o primeiro pode estornar.
   */
  private async refundLatePayment(order: Order, data: any, orderRepo: any): Promise<void> {
    const claim = await orderRepo.manager.query(
      `UPDATE orders SET notes = TRIM(COALESCE(notes, '') || $2), "updatedAt" = NOW()
        WHERE id = $1 AND COALESCE(notes, '') NOT LIKE '%[PAID_AFTER_EXPIRY%' RETURNING id`,
      [order.id, `\n[PAID_AFTER_EXPIRY ${new Date().toISOString()}] pagamento chegou com o pedido ${order.status}; estorno automatico em andamento.`],
    );
    if (linhasAfetadas(claim) === 0) return; // outro webhook ja assumiu

    try {
      // Localiza a cobranca REAL e confirma que esta paga antes de estornar.
      let chargeId: string | null = data.charges?.[0]?.id || null;
      if (!chargeId && data.id) {
        const pagarmeOrder = await this.pagarmeGet(`/orders/${data.id}`);
        chargeId = pagarmeOrder.charges?.[0]?.id ?? null;
      }
      if (!chargeId) throw new Error('cobranca nao localizada no payload nem no Pagar.me');

      const charge = await this.pagarmeGet(`/charges/${chargeId}`);
      if (charge.status !== 'paid' && charge.status !== 'captured') {
        throw new Error(`cobranca com status "${charge.status}" nao esta paga`);
      }

      // Total: o helper manda DELETE sem corpo, que e a forma validada.
      await this.estornarCobranca(chargeId, {
        idempotencyKey: `late-refund-${order.id}`,
      });
      this.logger.warn(
        `Late payment auto-refunded for ${order.status} order #${order.orderNumber} | charge: ${chargeId} | amount: ${charge.amount} cents`,
      );
      await orderRepo.manager.query(
        `UPDATE orders SET notes = TRIM(COALESCE(notes, '') || $2) WHERE id = $1`,
        [order.id, `\n[PAID_AFTER_EXPIRY_REFUNDED ${new Date().toISOString()}] ${charge.amount} centavos estornados.`],
      );

      if (order.customer?.id) {
        this.notificationsService.sendToAppUser(
          order.customer.id,
          'Pagamento estornado',
          `O pagamento do pedido #${order.orderNumber} chegou depois do prazo e o pedido já havia expirado. O valor será devolvido automaticamente ao seu meio de pagamento.`,
          { type: 'REFUND_REQUESTED', orderId: order.id },
        ).catch(() => {});
      }
      if (order.customer?.phone) {
        this.whatsAppService.sendText(
          order.customer.phone,
          `⏰ *Pagamento fora do prazo*\n\nO pagamento do pedido #${order.orderNumber} foi confirmado depois do prazo e o pedido já havia expirado.\n\n💰 O valor será devolvido automaticamente ao seu meio de pagamento em até 7 dias úteis.`,
        ).catch(() => {});
      }
    } catch (err: any) {
      // O claim ja gravou [PAID_AFTER_EXPIRY] — o caso e encontravel:
      //   SELECT * FROM orders WHERE notes LIKE '%[PAID_AFTER_EXPIRY]%'
      //     AND notes NOT LIKE '%[PAID_AFTER_EXPIRY_REFUNDED%';
      // Grava a falha e NAO solta o claim: estorno automatico so tenta uma vez
      // por webhook; o proximo webhook do mesmo pagamento re-tentaria com outra
      // Idempotency... nao — fica para reconciliacao manual, que e mais seguro
      // do que re-tentar as cegas um estorno de dinheiro.
      const motivo = err?.response?.data?.message || err?.message || 'unknown';
      this.logger.error(
        `Late payment refund FAILED for order #${order.orderNumber}: ${motivo}`,
      );
      await orderRepo.manager
        .query(`UPDATE orders SET notes = TRIM(COALESCE(notes, '') || $2) WHERE id = $1`, [
          order.id,
          `\n[PAID_AFTER_EXPIRY_REFUND_FAILED ${new Date().toISOString()}] ${motivo} — requer estorno manual.`,
        ])
        .catch(() => {});
    }
  }

  private async handleOrderPaymentFailed(data: any): Promise<void> {
    const metadata = data.metadata || data.order?.metadata || {};

    // Handle appointment payment failure
    if (metadata.type === 'appointment' && metadata.appointment_id) {
      const aptRepo = this.paymentsRepository.manager.getRepository(Appointment);
      const apt = await aptRepo.findOne({ where: { id: metadata.appointment_id }, relations: ['customer'] });
      if (apt) {
        apt.paymentStatus = 'FAILED';
        await aptRepo.save(apt);
        this.logger.warn(`Payment failed for appointment ${apt.appointmentNumber}`);
        if (apt.customer?.id) {
          this.notificationsService.sendToAppUser(
            apt.customer.id,
            'Pagamento recusado',
            `O pagamento do agendamento ${apt.appointmentNumber} foi recusado. Tente outro metodo.`,
            { type: 'APPOINTMENT_PAYMENT_FAILED', appointmentId: apt.id },
          ).catch(() => {});
        }
      }
      return;
    }

    const orderId = metadata.order_id;
    if (!orderId) return;

    this.logger.warn(`Payment failed for order ${orderId}`);

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'items', 'items.product'],
    });

    if (!order || order.status === OrderStatus.CANCELLED) return;

    // Don't cancel orders in PAYMENT_REVIEW — antifraud reproved but awaiting manual reprocessing
    if (order.status === OrderStatus.PAYMENT_REVIEW) {
      this.logger.log(`Pedido #${order.orderNumber} em PAYMENT_REVIEW — ignorando payment_failed webhook`);
      return;
    }

    // CRITICO (auditoria 2026-08-23): o claim so podia excluir os terminais, mas
    // isso deixava PENDING/ACCEPTED/.../COMPLETED passarem. Um `charge.payment_failed`
    // TARDIO (tentativa recusada num payment link que aceita varias tentativas)
    // chegando DEPOIS do `order.paid` da tentativa que pagou cancelava um pedido
    // JA PAGO e devolvia o estoque — sem disparar estorno neste handler. Cliente
    // pagava, pedido morria, dinheiro retido em silencio.
    // Falha de pagamento so pode cancelar pedido que ainda NAO foi pago
    // (AWAITING_PAYMENT). PAYMENT_REVIEW ja foi tratado com return acima; a partir
    // de PENDING o pedido esta pago e um payment_failed e de outra charge/tentativa.
    const claimFalha = await orderRepo.manager.query(
      `UPDATE orders SET status = 'CANCELLED', "updatedAt" = NOW()
         WHERE id = $1 AND status = 'AWAITING_PAYMENT' RETURNING id`,
      [order.id],
    );
    if (linhasAfetadas(claimFalha) === 0) return;
    order.status = OrderStatus.CANCELLED;
    this.logger.log(`Pedido #${order.orderNumber} cancelado por falha no pagamento`);

    // Restaurar estoque
    if (order.items) {
      const productRepo = this.paymentsRepository.manager.getRepository('Product');
      for (const item of order.items) {
        if (item.product?.id) {
          await productRepo.increment({ id: item.product.id }, 'stock', item.quantity);
        }
      }
    }

    // Notificar cliente
    if (order.customer?.id) {
      this.notificationsService.sendToAppUser(
        order.customer.id,
        'Pagamento recusado',
        `O pagamento do pedido #${order.orderNumber} foi recusado. Tente novamente com outro método de pagamento.`,
        { type: 'PAYMENT_FAILED', orderId: order.id },
      ).catch(() => {});
    }

    // Notificar vendor
    if (order.store?.owner?.id) {
      this.notificationsService.sendToVendorUser(
        order.store.owner.id,
        'Pedido cancelado',
        `Pedido #${order.orderNumber} cancelado - pagamento recusado.`,
        { type: 'ORDER_CANCELLED', orderId: order.id },
      ).catch(() => {});
    }
  }

  private async handleOrderCanceled(data: any): Promise<void> {
    const metadata = data.metadata || data.order?.metadata || {};
    const orderId = metadata.order_id;
    if (!orderId) return;

    this.logger.warn(`Order canceled on Pagar.me: ${orderId}`);

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'items', 'items.product'],
    });

    if (!order) return;

    // A guarda cobria so CANCELLED. Pedido ja em EXPIRED ou REJECTED — cujo
    // estoque JA foi devolvido pelo fluxo interno — passava por aqui, ganhava
    // estoque de novo e ainda tinha o status sobrescrito para CANCELLED por um
    // save de entidade inteira.
    //
    // Caminho deterministico, sem corrida: PIX em AWAITING_PAYMENT expira, o
    // scheduler devolve o estoque aos 30 min, e o QR tambem expira no Pagar.me,
    // que dispara `order.canceled` minutos depois. O webhook via EXPIRED !=
    // CANCELLED e devolvia tudo outra vez -> oversell na sequencia.
    //
    // CRITICO (auditoria 2026-08-23): antes o claim excluia so os terminais, o que
    // deixava um `order.canceled` TARDIO (ex.: cancelamento manual no painel do
    // Pagar.me, ou abandono de tentativa antiga num payment link) destruir um
    // pedido JA PAGO (PENDING+) e devolver o estoque, sem estornar. `order.canceled`
    // so representa cancelamento de order NAO paga (QR PIX expirado, tentativa
    // abandonada); estorno de pedido pago chega por `charge.refunded`/`chargedback`,
    // que revertem repasse corretamente. So cancelamos aqui se ainda AWAITING_PAYMENT.
    const claimCancel = await orderRepo.manager.query(
      `UPDATE orders SET status = 'CANCELLED', "updatedAt" = NOW()
         WHERE id = $1 AND status = 'AWAITING_PAYMENT' RETURNING id`,
      [order.id],
    );
    if (linhasAfetadas(claimCancel) === 0) return;
    order.status = OrderStatus.CANCELLED;
    this.logger.log(`Pedido #${order.orderNumber} cancelado via Pagar.me webhook`);

    // Restaurar estoque
    if (order.items) {
      const productRepo = this.paymentsRepository.manager.getRepository('Product');
      for (const item of order.items) {
        if (item.product?.id) {
          await productRepo.increment({ id: item.product.id }, 'stock', item.quantity);
        }
      }
    }

    if (order.customer?.id) {
      this.notificationsService.sendToAppUser(
        order.customer.id,
        'Pedido cancelado',
        `Seu pedido #${order.orderNumber} foi cancelado.`,
        { type: 'ORDER_CANCELLED', orderId: order.id },
      ).catch(() => {});
    }
  }

  /**
   * Extrai o UUID do PEDIDO de um evento de charge, ou null se a cobranca nao e
   * de pedido (plano/promocao/agendamento) ou se o code nao contem um UUID.
   *
   * BUGFIX: a derivacao antiga era `code.replace(/^([a-f0-9-]{36}).*$/, '$1')`,
   * mas String.replace DEVOLVE A STRING ORIGINAL quando o regex nao casa — entao
   * um code de plano avulso ("plan-xxxx") virava orderId = "plan-xxxx" e o
   * findOne por uuid lançava 22P02; como o handleWebhook re-lança, o Pagar.me
   * re-tentava o MESMO evento para sempre. A guarda de tipo existia so no
   * handleChargePaid; refunded/chargedback ficaram sem. Centralizado aqui: match
   * (nao replace) do padrao UUID + guarda de tipo, para os tres handlers.
   */
  private extractOrderIdFromCharge(data: any): string | null {
    const metadata = data.metadata || data.order?.metadata || {};
    if (['plan_upgrade', 'promotion', 'appointment'].includes(metadata.type)) {
      return null;
    }
    if (metadata.order_id) return metadata.order_id;
    const code = data.code || data.order?.code || '';
    const m = code.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0] : null;
  }

  private async handleChargePaid(data: any): Promise<void> {
    // Fallback: if order.paid webhook doesn't fire, charge.paid confirms the payment
    const orderId = this.extractOrderIdFromCharge(data);

    this.logger.log(`Charge paid: ${data.id} | orderId: ${orderId}`);

    if (!orderId) return;

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store'],
    });

    // Update mpPreferenceId with real Pagar.me order ID if still placeholder
    if (order && order.mpPreferenceId?.startsWith('link-')) {
      const realOrderId = data.order?.id || data.id;
      if (realOrderId) {
        order.mpPreferenceId = realOrderId;
        await orderRepo.save(order);
      }
    }

    // Act if order is AWAITING_PAYMENT or PAYMENT_REVIEW (antifraud reprocessed)
    const wasPaymentReview = order?.status === OrderStatus.PAYMENT_REVIEW;
    if (order && (order.status === OrderStatus.AWAITING_PAYMENT || order.status === OrderStatus.PAYMENT_REVIEW)) {
      // #2: verifica a cobrança no Pagar.me antes de confirmar (gated). data.id é
      // o id da própria cobrança neste evento.
      if (!(await this.webhookChargeConfirms(data.id, null, order, ['paid', 'captured', 'authorized', 'pending_capture'], true))) return;
      // R#4: transição ATÔMICA (ver handleOrderPaid). O próprio claim já dedup
      // entre order.paid e charge.paid: quem transiciona AWAITING/PAYMENT_REVIEW →
      // PENDING credita o cupom uma vez; o outro webhook acha o pedido já PENDING,
      // recebe 0 linhas e retorna. Dispensa o antigo snapshot `couponAlreadyCredited`.
      const setCaptured = wasPaymentReview && !!order.preAuthChargeId && !order.capturedAt;
      const chargeClaim = await orderRepo.manager.query(
        // CRITICO: idem ao handleOrderPaid — sem "updatedAt" = NOW() o
        // expirePendingOrders expira e estorna pedido que acabou de ser pago.
        `UPDATE orders SET status = 'PENDING', "couponCredited" = true, "updatedAt" = NOW()${setCaptured ? ', "capturedAt" = NOW()' : ''}
           WHERE id = $1 AND status IN ('AWAITING_PAYMENT','PAYMENT_REVIEW') RETURNING id`,
        [order.id],
      );
      if (linhasAfetadas(chargeClaim) === 0) return;
      order.status = OrderStatus.PENDING;
      order.couponCredited = true;
      if (setCaptured) {
        order.capturedAt = new Date();
        this.logger.log(`Charge.paid (antifraud reprocessed): marking capturedAt for order #${order.orderNumber} — charge was auto-captured by Pagar.me`);
      }
      this.logger.log(`Charge.paid ${wasPaymentReview ? '(antifraud reprocessed)' : 'fallback'}: pedido #${order.orderNumber} confirmado via charge webhook`);

      // Re-fetch with full relations so subscription filters can access store.id
      // (store.owner e delivery.deliverer são necessários para o filtro decidir
      // quem é parte do pedido).
      const freshOrder = await orderRepo.findOne({
        where: { id: order.id },
        relations: ['customer', 'store', 'store.owner', 'items', 'items.product', 'delivery', 'delivery.deliverer'],
      });

      // Publish real-time update so app/vendor panel refresh
      if (freshOrder) {
        this.pubSub.publish('orderUpdated', { orderUpdated: freshOrder });
        this.pubSub.publish('orderCreated', { orderCreated: freshOrder });
      }

      if (order.customer?.id) {
        this.notificationsService.sendToAppUser(
          order.customer.id,
          'Pagamento confirmado!',
          `Seu pagamento do pedido #${order.orderNumber} foi aprovado. Aguarde a confirmação da loja.`,
          { type: 'PAYMENT_CONFIRMED', orderId: order.id },
        ).catch(() => {});
      }
      if (order.customer?.phone) {
        this.whatsAppService.sendText(
          order.customer.phone,
          `✅ *Pagamento confirmado!*\n\nSeu pagamento do pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) foi aprovado.\n\nAguarde a confirmação da loja!`,
        ).catch(() => {});
      }

      // Cupom multi-uso (BUGFIX): a reserva do uso foi movida para a CRIACAO do
      // pedido (orders.service.create). Incrementar aqui, como o handleOrderPaid
      // tambem fazia, virou dupla contagem para o caminho de fallback. Removido.
    } else if (
      order &&
      [OrderStatus.EXPIRED, OrderStatus.CANCELLED, OrderStatus.REJECTED].includes(
        order.status as OrderStatus,
      )
    ) {
      // BUGFIX (fallback tardio): se o charge.paid chega com o pedido JA terminal
      // — e o order.paid, que trataria isso, nao disparou — estorna
      // automaticamente, igual ao handleOrderPaid. Sem este ramo o cliente pagava,
      // o pedido ficava expirado e o dinheiro retido, sem estorno nem marcador.
      await this.refundLatePayment(order, data, orderRepo);
    }
  }

  private async handleChargeRefunded(data: any): Promise<void> {
    // BUGFIX: sem a guarda/extracao segura, um estorno de PLANO avulso PIX
    // (code "plan-...") virava um findOne com uuid invalido → 22P02 → retry
    // infinito do Pagar.me. extractOrderIdFromCharge devolve null nesses casos.
    const orderId = this.extractOrderIdFromCharge(data);

    this.logger.log(`Charge refunded: ${data.id} | orderId: ${orderId}`);

    if (!orderId) return;

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'items', 'items.product', 'delivery', 'delivery.deliverer'],
    });

    if (order && order.status !== OrderStatus.CANCELLED) {
      // #3: confirma no Pagar.me que a cobrança foi mesmo estornada antes de
      // cancelar + reverter repasse (gated). Impede um `charge.refunded` forjado
      // de puxar dinheiro de volta do vendedor/entregador.
      if (!(await this.webhookChargeConfirms(data.id, null, order, ['refunded', 'partially_refunded', 'chargedback'], false))) return;

      // BUGFIX: `partially_refunded` caia no mesmo caminho do estorno TOTAL —
      // cancelava o pedido inteiro e revertia 100% dos repasses. Um reembolso de
      // cortesia de R$10 num pedido entregue de R$200 puxava de volta os ~R$190
      // ja repassados ao vendedor e marcava o pedido como cancelado.
      // Estorno parcial nao cancela nem reverte: registra e fica para conferencia
      // manual (a plataforma decide como ratear).
      const chargeStatus = String(data?.status || '').toLowerCase();
      const isPartial =
        chargeStatus === 'partially_refunded' ||
        (typeof data?.amount === 'number' &&
          typeof data?.paid_amount === 'number' &&
          data.amount > 0 &&
          data.amount < data.paid_amount);
      if (isPartial) {
        this.logger.warn(
          `Estorno PARCIAL na cobranca ${data.id} do pedido #${order.orderNumber} — ` +
            `pedido NAO cancelado e repasses NAO revertidos. Conferencia manual necessaria.`,
        );
        await orderRepo.manager.query(
          `UPDATE orders SET notes = TRIM(COALESCE(notes, '') || $2) WHERE id = $1`,
          [order.id, `
[PARTIAL_REFUND ${new Date().toISOString()}] charge=${data.id}`],
        );
        return;
      }

      // ATOMICO (auditoria 2026-08-23): antes era read-check-save com guarda so
      // `!= CANCELLED` + `save(order)` de entidade inteira. Um pedido ja em
      // REJECTED/EXPIRED pelo NOSSO proprio refundOrder (ex.: vendedor rejeita PIX
      // pago -> refundOrder estorna e devolve estoque, status=REJECTED) passava a
      // guarda quando o Pagar.me disparava o `charge.refunded` correspondente ->
      // estoque devolvido uma SEGUNDA vez (oversell) e status sobrescrito. Claim
      // atomico com a lista COMPLETA de terminais (igual aos outros handlers),
      // capturando o status anterior no mesmo comando para decidir wasCompleted e
      // se havia repasse a reverter. 0 linhas = outro fluxo ja encerrou -> no-op.
      const [claim] = await orderRepo.manager.query(
        `WITH prev AS (SELECT status, "isSettled" FROM orders WHERE id = $1 FOR UPDATE)
         UPDATE orders o SET status = 'CANCELLED', "updatedAt" = NOW()
         FROM prev
         WHERE o.id = $1 AND prev.status NOT IN ('CANCELLED','REJECTED','EXPIRED')
         RETURNING prev.status AS old_status, prev."isSettled" AS was_settled`,
        [order.id],
      );
      if (!claim) {
        this.logger.log(`Estorno de #${order.orderNumber} ignorado — pedido ja terminal (sem re-devolver estoque)`);
        return;
      }
      const wasCompleted = claim.old_status === OrderStatus.COMPLETED;
      order.status = OrderStatus.CANCELLED;
      this.logger.log(`Pedido #${order.orderNumber} cancelado por estorno | wasCompleted: ${wasCompleted}`);

      // Se o pedido ja estava COMPLETED e liquidado, reverter os repasses ao
      // vendedor/entregador antes que a plataforma absorva o prejuizo. O guard
      // `status !== CANCELLED` acima ja evita reversao dupla quando o nosso
      // proprio refundOrder rodou primeiro (ele seta CANCELLED). Esse caminho
      // cobre o estorno iniciado direto no painel do Pagar.me, que dispara
      // charge.refunded sem passar pelo refundOrder.
      // BUGFIX: era `wasCompleted && isSettled`. `resolveDispute` liquida o
      // pedido ENQUANTO ele ainda esta DISPUTED e so depois transiciona para
      // COMPLETED — se essa transicao falhar, sobra um pedido liquidado que nunca
      // ficou COMPLETED. No estorno seguinte a reversao era pulada e a plataforma
      // devolvia ao cliente sem recuperar o repasse. `isSettled` sozinho ja e a
      // condicao correta ("o dinheiro ja saiu") e reverseSettlementTransfers ja
      // e no-op quando nao houve liquidacao.
      if (claim.was_settled) {
        this.logger.error(`CRITICAL: Estorno em pedido COMPLETED #${order.orderNumber} — revertendo repasses`);
        try {
          await this.reverseSettlementTransfers(order);
        } catch (err: any) {
          this.logger.error(`CRITICAL: Reversao de repasse falhou no estorno do pedido #${order.orderNumber}: ${err.message}`);
        }
      }

      // Restaurar estoque apenas se o pedido NAO foi entregue/concluido
      // (produto ja entregue nao volta pro estoque).
      if (!wasCompleted && order.items) {
        const productRepo = this.paymentsRepository.manager.getRepository('Product');
        for (const item of order.items) {
          if (item.product?.id) {
            await productRepo.increment({ id: item.product.id }, 'stock', item.quantity);
          }
        }
      }

      if (order.customer?.id) {
        this.notificationsService.sendToAppUser(
          order.customer.id,
          'Reembolso processado',
          `O reembolso do pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) foi processado. O valor será devolvido ao seu meio de pagamento.`,
          { type: 'REFUND_PROCESSED', orderId: order.id },
        ).catch(() => {});
      }
      if (order.customer?.phone) {
        this.whatsAppService.sendText(
          order.customer.phone,
          `💰 *Reembolso processado!*\n\nO valor de R$ ${Number(order.total).toFixed(2)} do pedido #${order.orderNumber} será devolvido ao seu meio de pagamento.`,
        ).catch(() => {});
      }
    }
  }

  private async handleChargeChargedback(data: any): Promise<void> {
    // BUGFIX: mesma guarda do refunded — chargeback de plano/promo/agendamento
    // nao pode virar findOne com uuid invalido (22P02 → retry infinito).
    const orderId = this.extractOrderIdFromCharge(data);

    this.logger.warn(`Chargeback received: ${data.id} | orderId: ${orderId}`);

    if (!orderId) return;

    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'items', 'items.product', 'delivery', 'delivery.deliverer'],
    });

    if (order) {
      // #3: confirma no Pagar.me que houve mesmo chargeback antes de cancelar +
      // reverter repasse (gated). Impede um `charge.chargedback` forjado.
      if (!(await this.webhookChargeConfirms(data.id, null, order, ['chargedback', 'refunded'], false))) return;
      const wasCompleted = order.status === OrderStatus.COMPLETED;
      // Este handler nao tinha guarda de status NENHUMA (ao contrario do de
      // estorno). Um pedido ja encerrado — estornado manualmente, por exemplo —
      // tinha o estoque devolvido outra vez. O claim diz se ESTE fluxo foi quem
      // encerrou o pedido; a reversao de repasse continua acontecendo em ambos
      // os casos (o dinheiro andou de verdade), mas agora e idempotente por
      // conta propria.
      const claimChargeback = await orderRepo.manager.query(
        `UPDATE orders SET status = 'CANCELLED', "updatedAt" = NOW()
           WHERE id = $1 AND status NOT IN ('CANCELLED','REJECTED','EXPIRED') RETURNING id`,
        [order.id],
      );
      const encerradoAqui = linhasAfetadas(claimChargeback) > 0;
      order.status = OrderStatus.CANCELLED;
      this.logger.warn(`Pedido #${order.orderNumber} cancelado por chargeback | wasCompleted: ${wasCompleted} | encerradoAqui: ${encerradoAqui}`);

      // C1: If order was COMPLETED, reverse settlement transfers
      // BUGFIX: era `wasCompleted && isSettled`. `resolveDispute` liquida o
      // pedido ENQUANTO ele ainda esta DISPUTED e so depois transiciona para
      // COMPLETED — se essa transicao falhar, sobra um pedido liquidado que nunca
      // ficou COMPLETED. No estorno seguinte a reversao era pulada e a plataforma
      // devolvia ao cliente sem recuperar o repasse. `isSettled` sozinho ja e a
      // condicao correta ("o dinheiro ja saiu") e reverseSettlementTransfers ja
      // e no-op quando nao houve liquidacao.
      if (order.isSettled) {
        this.logger.error(`CRITICAL: Chargeback on COMPLETED order #${order.orderNumber} — reversing transfers`);
        try {
          await this.reverseSettlementTransfers(order, 'chargeback');
        } catch (err: any) {
          this.logger.error(`CRITICAL: Transfer reversal failed for chargeback on order #${order.orderNumber}: ${err.message}`);
        }
      }

      // Only restore stock if order was NOT already completed/delivered (products
      // not physically delivered) E se foi este fluxo que encerrou o pedido —
      // senao o estoque ja foi devolvido por quem encerrou antes.
      if (!wasCompleted && encerradoAqui && order.items) {
        const productRepo = this.paymentsRepository.manager.getRepository('Product');
        for (const item of order.items) {
          if (item.product?.id) {
            await productRepo.increment({ id: item.product.id }, 'stock', item.quantity);
          }
        }
      }

      // Notify vendor about chargeback
      if (order.store?.owner?.id) {
        const transferWarning = wasCompleted
          ? ' Os produtos ja foram entregues e as transferencias estao sendo revertidas.'
          : '';
        this.notificationsService.sendToVendorUser(
          order.store.owner.id,
          'Chargeback recebido',
          `O pedido #${order.orderNumber} (R$ ${Number(order.total).toFixed(2)}) recebeu uma contestação (chargeback).${transferWarning}`,
          { type: 'CHARGEBACK', orderId: order.id },
        ).catch(() => {});
      }
    }
  }

  // ─── Refund ───────────────────────────────────────────────────────────

  /**
   * @param statusFinal estado terminal a gravar no claim. O padrao e CANCELLED,
   * mas rejeicao e expiracao precisam preservar o proprio estado — antes este
   * metodo forcava CANCELLED em todos os casos, e o chamador seguinte tentava
   * `updateStatus(REJECTED)` a partir de um pedido ja CANCELLED, cuja lista de
   * transicoes e vazia. O `updateStatus` lancava, e com ele iam embora a
   * RESTAURACAO DE ESTOQUE e a devolucao do cupom, que so acontecem la dentro.
   */
  async refundOrder(
    orderId: string,
    statusFinal: OrderStatus = OrderStatus.CANCELLED,
  ): Promise<{ success: boolean; message: string }> {
    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: ['customer', 'store', 'store.owner', 'delivery', 'delivery.deliverer'],
    });

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (!order.mpPreferenceId && !order.preAuthChargeId) throw new BadRequestException('Este pedido não possui pagamento online para estornar');

    // Pedido terminal COM marcador de estorno falho e re-tentavel. Sem isso, um
    // estorno que caia por timeout/5xx deixava o pedido CANCELLED para sempre:
    // re-chamar batia neste guard e NENHUM endpoint conseguia re-estornar — o
    // cliente ficava sem o dinheiro e so uma reconciliacao manual no Pagar.me
    // resolvia.
    const jaTerminal = [OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.EXPIRED]
      .includes(order.status as OrderStatus);
    const retryDeEstornoFalho = jaTerminal && (order.notes || '').includes('[REFUND_FAILED');
    if (jaTerminal && !retryDeEstornoFalho) {
      throw new BadRequestException('Este pedido já foi cancelado/rejeitado');
    }

    // R#1: claim atômico do estorno. ANTES o CANCELLED só era gravado DEPOIS do
    // estorno externo, então duas chamadas concorrentes (ex.: cliente cancela +
    // scheduler expira o mesmo pedido) passavam ambas pela checagem acima e
    // estornavam / revertiam repasse em DOBRO. Agora marcamos CANCELLED de forma
    // condicional e atômica ANTES de qualquer chamada ao Pagar.me; se 0 linhas,
    // outro fluxo já assumiu o cancelamento e abortamos.
    const wasCompleted = order.status === OrderStatus.COMPLETED;
    const wasSettled = order.isSettled;
    if (retryDeEstornoFalho) {
      // Claim do RETRY: consome o marcador de forma atomica (vira [REFUND_RETRY,
      // que o guard acima nao reconhece), entao duas re-tentativas concorrentes
      // nao passam juntas. Se o estorno falhar de novo, o catch grava um
      // [REFUND_FAILED] novo e o pedido volta a ser re-tentavel.
      const claim = await orderRepo.manager.query(
        `UPDATE orders SET notes = replace(notes, '[REFUND_FAILED', '[REFUND_RETRY'), "updatedAt" = NOW()
           WHERE id = $1 AND notes LIKE '%[REFUND_FAILED%' RETURNING id`,
        [order.id],
      );
      if (linhasAfetadas(claim) === 0) {
        throw new BadRequestException('Este pedido já está sendo re-estornado.');
      }
      // status ja e terminal; nao mexe nele.
    } else {
      const claim = await orderRepo.manager.query(
        `UPDATE orders SET status = $2, "updatedAt" = NOW()
           WHERE id = $1 AND status NOT IN ('CANCELLED','REJECTED','EXPIRED') RETURNING id`,
        [order.id, statusFinal],
      );
      if (linhasAfetadas(claim) === 0) {
        throw new BadRequestException('Este pedido já está sendo cancelado/estornado.');
      }
      order.status = statusFinal; // reflete o claim no objeto em memória
    }

    // C3: If order was COMPLETED and settled, reverse transfers before refunding.
    // A partir daqui o pedido JÁ está CANCELLED no banco: se o estorno externo
    // falhar, ele permanece cancelado e sinalizado p/ reconciliação manual — o
    // que é preferível a um estorno em dobro.
    // BUGFIX: idem — `isSettled` e a condicao real de "dinheiro ja repassado".
    if (wasSettled) {
      this.logger.warn(`Refund requested for completed+settled order #${order.orderNumber} — reversing transfers first`);
      try {
        await this.reverseSettlementTransfers(order);
      } catch (err: any) {
        // KAN-233: a reversao falhar (ex.: saldo insuficiente no recebedor do
        // vendedor) e um prejuizo direto: o cliente sera estornado abaixo, mas
        // o dinheiro ja repassado nao volta. Antes isso so gerava um log e a
        // plataforma absorvia a perda em SILENCIO.
        //
        // O estorno segue de proposito — travar aqui puniria o cliente por um
        // problema entre plataforma e recebedor. Mas agora fica registrado no
        // proprio pedido, para reconciliacao manual:
        //   SELECT * FROM orders WHERE notes LIKE '%REVERSAL_FAILED%';
        this.logger.error(`Transfer reversal failed before refund for order #${order.orderNumber}: ${err.message}`);
        const marker = `\n[REVERSAL_FAILED_BEFORE_REFUND ${new Date().toISOString()}] ${err?.message || 'unknown'} — cliente sera estornado; valor repassado NAO retornou. Requer reconciliacao manual.`;
        await orderRepo.manager
          .query(`UPDATE orders SET notes = TRIM(COALESCE(notes, '') || $2) WHERE id = $1`, [
            order.id,
            marker,
          ])
          .catch((e: any) =>
            this.logger.error(`Failed to flag reversal failure for order ${order.id}: ${e?.message}`),
          );
      }
    }

    try {
      let chargeId: string | null = null;
      let chargeAmount: number = Math.round(Number(order.total) * 100);

      // 1. Try preAuthChargeId (direct card charge / pre-auth flow)
      if (order.preAuthChargeId) {
        chargeId = order.preAuthChargeId;
      }
      // 2. Try mpPreferenceId as Pagar.me order ID (PIX or payment link with real ID)
      else if (order.mpPreferenceId && !order.mpPreferenceId.startsWith('link-')) {
        const pagarmeOrder = await this.pagarmeGet(`/orders/${order.mpPreferenceId}`);
        const charge = pagarmeOrder.charges?.[0];
        if (!charge) throw new BadRequestException('Cobrança não encontrada no Pagar.me');
        chargeId = charge.id;
        chargeAmount = charge.amount;
      }
      // 3. Payment link placeholder — cannot refund without real charge ID
      else {
        throw new BadRequestException('Não foi possível localizar a cobrança no Pagar.me para estorno. O webhook pode não ter atualizado o ID do pedido.');
      }

      // Guarda explicita: os ramos acima ou atribuem `chargeId` ou lancam, mas o
      // tipo segue `string | null`. Antes isso passava porque o id ia dentro de
      // template string (que aceita null e geraria a URL "/charges/null"); agora
      // ele e passado como argumento, e o compilador cobra — com razao.
      if (!chargeId) {
        throw new BadRequestException('Cobrança não localizada no Pagar.me para estorno.');
      }

      // Verify charge status before refunding
      const chargeData = await this.pagarmeGet(`/charges/${chargeId}`);
      const st = String(chargeData.status || '').toLowerCase();
      if (st === 'authorized' || st === 'pending_capture' || st === 'pending') {
        // ALTO (auditoria 2026-08-23): cartão PRÉ-AUTORIZADO ainda não capturado.
        // Ocorre na disputa a favor do cliente a partir de DELIVERER_CONFIRMED_DELIVERY
        // (antes do settle/captura): a charge está só `authorized`. Um /refund é
        // recusado pelo Pagar.me -> [REFUND_FAILED] em loop e o limite do cliente
        // fica preso até a pré-auth caducar (dias). O correto é VOID (DELETE /charges),
        // que libera a autorização na hora e não move dinheiro (não houve captura).
        // Mesma troca do `cancelPreAuth`: o void agora e conferido. Aqui a
        // excecao SOBE — e o certo neste caminho. O bloco externo marca
        // [REFUND_FAILED] e permite nova tentativa; dar o estorno por feito sem
        // ter liberado a autorizacao seria pior, porque e justamente o cenario
        // que o comentario acima descreve como o bug original.
        await this.estornarCobranca(chargeId);
        this.logger.log(`Pre-auth voided (refund path) for order #${order.orderNumber} | charge: ${chargeId}`);
      } else if (st === 'paid' || st === 'captured') {
        // Dinheiro ja capturado: estorno de verdade. O helper confere
        // `last_transaction.status` — o 200 do provedor nao garante nada.
        await this.estornarCobranca(chargeId);
      } else if (st === 'refunded' || st === 'voided' || st === 'canceled') {
        // Já estornada/cancelada no gateway — idempotente, segue como sucesso.
        this.logger.log(`Charge ${chargeId} já está "${st}" — estorno idempotente p/ pedido #${order.orderNumber}`);
      } else {
        throw new BadRequestException(`Cobrança com status "${chargeData.status}" não pode ser estornada`);
      }

      // status CANCELLED já foi gravado no claim atômico acima (R#1).
      this.logger.log(`Refund requested for order #${order.orderNumber} | charge: ${chargeId}`);

      // Notify customer
      if (order.customer?.id) {
        this.notificationsService.sendToAppUser(
          order.customer.id,
          'Pedido estornado',
          `O pedido #${order.orderNumber} foi cancelado e o reembolso de R$ ${Number(order.total).toFixed(2)} será processado.`,
          { type: 'REFUND_REQUESTED', orderId: order.id },
        ).catch(() => {});
      }
      if (order.customer?.phone) {
        this.whatsAppService.sendText(
          order.customer.phone,
          `💰 *Pedido cancelado e reembolso solicitado!*\n\nO valor de R$ ${Number(order.total).toFixed(2)} do pedido #${order.orderNumber} será devolvido ao seu meio de pagamento em até 7 dias úteis.`,
        ).catch(() => {});
      }

      return { success: true, message: `Estorno solicitado para o pedido #${order.orderNumber}` };
    } catch (err: any) {
      // O pedido JA esta terminal (claim acima) e o dinheiro NAO voltou. Sem
      // este marcador a falha era invisivel: nenhuma query encontrava o pedido e
      // o guard de re-chamada rejeitava para sempre. Com ele:
      //   SELECT * FROM orders WHERE notes LIKE '%[REFUND_FAILED%';
      // e o proprio refundOrder aceita a re-tentativa (guard + claim acima).
      const errorData = err.response?.data;
      const motivo = errorData?.message || err?.message || 'unknown';
      this.logger.error(`Refund failed: ${JSON.stringify(errorData || err.message)}`);
      const marker = `\n[REFUND_FAILED ${new Date().toISOString()}] ${motivo} — pedido terminal SEM estorno; re-chamar refundOrder re-tenta.`;
      await orderRepo.manager
        .query(`UPDATE orders SET notes = TRIM(COALESCE(notes, '') || $2) WHERE id = $1`, [
          order.id,
          marker,
        ])
        .catch((e: any) =>
          this.logger.error(`Failed to flag refund failure for order ${order.id}: ${e?.message}`),
        );
      if (err instanceof BadRequestException || err instanceof NotFoundException) throw err;
      throw new BadRequestException(errorData?.message || 'Erro ao solicitar estorno');
    }
  }

  // ─── Recipient Balance & Anticipation ─────────────────────────────────

  /**
   * Data de pagamento valida para uma antecipacao, no formato "YYYY-MM-DD".
   *
   * A regra e do proprio Pagar.me e veio da mensagem de validacao dele:
   *   "prazo minimo de antecipacao: D+0 ate 11AM ou D+1"
   * Ou seja: ate as 11h da manha da-se para antecipar no MESMO dia; depois
   * disso, o mais cedo possivel e o proximo dia util.
   *
   * O codigo anterior nao tratava esse corte de 11h de jeito nenhum: montava a
   * data com `new Date()` + `toISOString()`, ou seja em UTC, e so desviava de
   * sabado e domingo. Dois problemas:
   *
   *  - Entre 11h e 21h de um dia util (a faixa em que o lojista mais usa o app),
   *    mandava D+0, que o Pagar.me RECUSA com "data de pagamento invalida".
   *  - O desvio de fim de semana lia o dia da semana em UTC. Entre 21h e
   *    meia-noite de Brasilia a data UTC ja e a de amanha, entao a conta do fim
   *    de semana era feita sobre o dia errado.
   *
   * Aqui tudo e decidido no fuso do NEGOCIO (America/Sao_Paulo), com os helpers
   * de business-time.ts — que existem exatamente por causa desta classe de bug
   * e nunca tinham chegado neste arquivo.
   *
   * Feriado nacional nao e tratado (nem era antes): nao ha calendario de
   * feriados no projeto. Nesse caso o Pagar.me recusa a data e o erro chega ao
   * lojista — o que e visivel, ao contrario de uma data silenciosamente errada.
   */
  private static dataDeAntecipacao(agora: Date = new Date()): string {
    const CORTE_MINUTOS = 11 * 60; // 11:00 no fuso do negocio
    // Parte do dia comercial de hoje e caminha em dias inteiros sobre ele.
    const [ano, mes, dia] = businessToday(agora).split('-').map(Number);
    const data = new Date(Date.UTC(ano, mes - 1, dia));

    // Passou das 11h? O mais cedo possivel ja e amanha.
    if (businessMinutes(agora) >= CORTE_MINUTOS) {
      data.setUTCDate(data.getUTCDate() + 1);
    }
    // E anda para o proximo dia util. getUTCDay() aqui e seguro: `data` foi
    // construida a partir da data BRASILEIRA ao meio-dia-zero UTC, entao o dia
    // da semana e o brasileiro.
    while (data.getUTCDay() === 0 || data.getUTCDay() === 6) {
      data.setUTCDate(data.getUTCDate() + 1);
    }
    return data.toISOString().split('T')[0];
  }

  /**
   * Centavos a liberar ("waiting funds") de um recebedor, a partir da resposta
   * de `GET /recipients/{id}/balance`.
   *
   * BUG CORRIGIDO AQUI (confirmado ao vivo em 15/10/2026): o codigo lia
   * `balance.waiting_funds?.amount` — forma ANINHADA, da v4 — em quatro pontos.
   * A v5 devolve o campo PLANO. Resposta real do sandbox:
   *
   *   { "currency": "BRL", "available_amount": 0, "waiting_funds_amount": -99,
   *     "transferred_amount": 0, "payment_profile_id": null, "recipient": {...} }
   *
   * Entao `waiting_funds` era sempre undefined, o `?.amount` virava undefined e
   * o `|| 0` fechava a conta em ZERO. Consequencias, todas em producao:
   *
   *  - "Valores a liberar" mostrava R$ 0,00 para TODO vendedor e entregador,
   *    independente do que existisse de fato;
   *  - `simulateAnticipation` e `requestAnticipation` liam o mesmo campo, viam
   *    zero e desistiam antes de chamar o provedor;
   *  - a tela de ganhos so renderiza a secao de antecipacao quando
   *    `waitingFundsAmount > 0`, entao a secao NUNCA apareceu.
   *
   * Isso explica por que o caminho errado de antecipacao (ver
   * `simulateAnticipation`) nunca deu sinal: o codigo nem chegava a chama-lo.
   *
   * O leitor aceita as DUAS formas de proposito. Nao e indecisao: e um ponto de
   * integracao com um provedor que ja mudou de forma uma vez, e cair para a
   * forma antiga custa uma linha e evita que o campo volte a zerar em silencio
   * se a resposta variar entre ambientes.
   */
  /**
   * O erro do provedor e o bloqueio de ORIGEM (allowlist de IP), e nao uma falha
   * passageira?
   *
   * Importa porque muda o que fazer: falha passageira merece retry; bloqueio de
   * configuracao nossa nao melhora com repeticao. O settlement re-tentava a cada
   * 60s por ate 48h contra um 401 que nunca ia mudar, e a cada rodada avisava o
   * LOJISTA que "a transferencia falhou - entre em contato com o suporte", o que
   * joga nele um problema que e nosso.
   */
  private static ehBloqueioDeOrigem(err: any): boolean {
    const status = err?.response?.status;
    const msg = String(
      err?.response?.data?.message || err?.message || '',
    ).toLowerCase();
    return status === 401 || msg.includes('ip de origem') || msg.includes('not authorized');
  }

  private static centavosAguardando(balance: any): number {
    const plano = balance?.waiting_funds_amount;
    if (typeof plano === 'number') return plano;
    const aninhado = balance?.waiting_funds?.amount;
    if (typeof aninhado === 'number') return aninhado;
    return 0;
  }

  async getRecipientBalance(recipientId: string): Promise<{ availableAmount: number; waitingFundsAmount: number; transferredAmount: number; autoAnticipationEnabled: boolean }> {
    try {
      const [balance, recipient] = await Promise.all([
        this.pagarmeGet(`/recipients/${recipientId}/balance`),
        this.pagarmeGet(`/recipients/${recipientId}`).catch(() => null),
      ]);
      return {
        availableAmount: (balance.available_amount || 0) / 100,
        waitingFundsAmount: PaymentsService.centavosAguardando(balance) / 100,
        transferredAmount: (balance.transferred_amount || 0) / 100,
        autoAnticipationEnabled: recipient?.automatic_anticipation_settings?.enabled ?? false,
      };
    } catch (err: any) {
      this.logger.warn(`Failed to get recipient balance: ${err.response?.data?.message || err.message}`);
      throw new BadRequestException('Não foi possível consultar o saldo. Tente novamente mais tarde.');
    }
  }

  /**
   * HISTORICO — O CAMINHO DE ANTECIPACAO ESTAVA ERRADO (corrigido em 15/10/2026).
   *
   * O caminho usado aqui e no requestAnticipation era
   * `/recipients/{id}/anticipations`, que NAO EXISTE na v5: e nome da v4. Na v5 o
   * recurso vive em `/recipients/{id}/bulk_anticipations`, e a simulacao e uma
   * rota propria, `/bulk_anticipations/simulate`.
   *
   * Verificado contra o sandbox em 14/10/2026, usando o recebedor da PLATAFORMA
   * (que existe: GET /recipients/{id} responde 200):
   *   GET /recipients/{plataforma}/anticipations      -> 404 com CORPO VAZIO
   *   GET /recipients/{plataforma}/rota_inventada_xyz -> 404 com CORPO VAZIO  (identico)
   *   GET /recipients/{id}/balance (recebedor falso)  -> 404 {"message":"The recipient could not be found"}
   *   GET /recipients/{plataforma}/bulk_anticipations -> 401 {"message":"IP de origem nao autorizado..."}
   * Ou seja: `/anticipations` responde como ROTA INEXISTENTE (igual a uma rota
   * que eu inventei), enquanto `/bulk_anticipations` responde como rota que
   * EXISTE e esta barrada por allowlist de IP. Nao e recebedor ausente.
   *
   * Consequencias, as duas em producao hoje:
   *  - `requestAnticipation` SEMPRE falha com 404. A antecipacao nunca funcionou,
   *    em nenhum ambiente.
   *  - `simulateAnticipation` SEMPRE cai no catch abaixo e devolvia uma taxa fixa
   *    de 3,5% com a mesma forma de uma cotacao real. A tela de ganhos mostra
   *    "Voce recebe R$ X" em destaque, e aquele X era invencao nossa.
   *
   * Nada disso aparecia porque o catch so logava `warn`.
   *
   * NAO corrigi o caminho aqui de proposito. Corrigir exige (a) confirmar os
   * nomes dos campos do corpo na v5 — o codigo manda `requested_amount` e
   * `type`, que sao da v4 — e (b) a allowlist de IP do Pagar.me, que nao esta
   * configurada e nao e algo que se resolva no codigo (o mesmo bloqueio ja
   * conhecido do `/transfers`). Chutar o corpo certo numa rota que MOVE DINHEIRO,
   * sem poder testar, troca "falha sempre e em silencio" por "faz algo
   * inesperado" — que e pior. O estado atual falha fechado; o que mudo aqui e
   * parar de MENTIR o numero e passar a gritar no log.
   */
  async simulateAnticipation(recipientId: string): Promise<{ originalAmount: number; anticipatedAmount: number; fee: number; feePercentage: number; isEstimate: boolean }> {
    try {
      // Get waiting funds first
      const balance = await this.pagarmeGet(`/recipients/${recipientId}/balance`);
      const waitingCents = PaymentsService.centavosAguardando(balance);

      if (waitingCents <= 0) {
        // Saldo a liberar veio do provedor e e zero: valor real, nao estimativa.
        return { originalAmount: 0, anticipatedAmount: 0, fee: 0, feePercentage: 0, isEstimate: false };
      }

      // CAMINHO CORRIGIDO. Era `POST /recipients/{id}/anticipations` com
      // `simulate: true`, e nenhuma das duas coisas existe na v5: a rota e
      // `/bulk_anticipations` e a simulacao e uma ROTA PROPRIA, nao um campo.
      //
      // Contrato confirmado contra a API em 15/10/2026, interrogando o endpoint
      // de simulacao (que devolve 400 com a lista de campos e, ao contrario da
      // rota de criacao, NAO e barrado pelo allowlist de IP):
      //   {}                                   -> "valor esta faltando, data de pagamento invalida
      //                                          (prazo minimo: D+0 ate 11AM ou D+1), tipo de
      //                                          antecipacao invalido (opcoes: 'start','end')"
      //   { amount: ... }                      -> continua "valor esta faltando"  => NAO e `amount`
      //   { requested_amount: ... }            -> a reclamacao de valor SAI       => e `requested_amount`
      //   { type: 'start' }                    -> continua "tipo invalido"        => NAO e `type`
      //   { timeframe: 'start' }               -> a reclamacao de tipo SAI        => e `timeframe`
      // Com os tres campos validos, o erro passa a ser de regra de negocio
      // ("O valor requisitado esta fora do permitido para este recebedor"), o
      // que confirma que a rota existe e valida de verdade.
      //
      // Ou seja: os NOMES dos campos no codigo ja estavam certos; o que estava
      // errado era o caminho, mais o `type: 'full'` e o `simulate: true`, que
      // nao sao campos de nada.
      const result = await this.pagarmePost(
        `/recipients/${recipientId}/bulk_anticipations/simulate`,
        {
          payment_date: PaymentsService.dataDeAntecipacao(),
          timeframe: 'start',
          requested_amount: waitingCents,
        },
      );

      const originalAmount = waitingCents / 100;
      const anticipatedAmount = (result.amount || 0) / 100;
      const fee = originalAmount - anticipatedAmount;
      const feePercentage = originalAmount > 0 ? (fee / originalAmount) * 100 : 0;

      // Cotacao de verdade, vinda do provedor.
      return {
        originalAmount,
        anticipatedAmount,
        fee,
        feePercentage: Math.round(feePercentage * 100) / 100,
        isEstimate: false,
      };
    } catch (err: any) {
      // ERROR, nao WARN: hoje este caminho e percorrido em TODA chamada (ver o
      // comentario do metodo) e ninguem notou em meses justamente porque era um
      // warn sem marcador. O marcador existe para dar grep e alerta.
      this.logger.error(
        `[ANTECIPACAO_INDISPONIVEL] simulacao falhou para ${recipientId}: ` +
          `${err.response?.data?.message || err.message}. ` +
          `O caminho ja esta no formato v5 (/bulk_anticipations); o bloqueio provavel ` +
          `e a allowlist de IP do Pagar.me, a mesma que barra o /transfers.`,
      );
      // Fallback: estimativa de ~3,5%, MARCADA como estimativa. O valor serve
      // para a pessoa ter uma nocao de ordem de grandeza; o que nao pode e ele
      // se passar por cotacao do provedor, que era o caso antes.
      try {
        const balance = await this.pagarmeGet(`/recipients/${recipientId}/balance`);
        const waitingCents = PaymentsService.centavosAguardando(balance);
        const originalAmount = waitingCents / 100;
        const estimatedFee = originalAmount * 0.035;
        return {
          originalAmount,
          anticipatedAmount: originalAmount - estimatedFee,
          fee: Math.round(estimatedFee * 100) / 100,
          feePercentage: 3.5,
          isEstimate: true,
        };
      } catch {
        return { originalAmount: 0, anticipatedAmount: 0, fee: 0, feePercentage: 0, isEstimate: true };
      }
    }
  }

  async requestAnticipation(recipientId: string): Promise<{ id: string; status: string; requestedAmount: number; approvedAmount: number; fee: number; createdAt: string }> {
    const balance = await this.pagarmeGet(`/recipients/${recipientId}/balance`);
    const waitingCents = PaymentsService.centavosAguardando(balance);

    if (waitingCents <= 0) {
      throw new BadRequestException('Não há valores pendentes para antecipar');
    }

    try {
      // Data pela regra do provedor (D+0 ate 11h, senao proximo dia util), no
      // fuso do negocio. Ver dataDeAntecipacao: o calculo anterior era em UTC e
      // ignorava o corte das 11h.
      const paymentDate = PaymentsService.dataDeAntecipacao();

      // CAMINHO CORRIGIDO: /bulk_anticipations (v5), nao /anticipations (v4).
      // Os nomes dos campos foram confirmados contra a API — ver o comentario em
      // simulateAnticipation. O `type: 'full'` saiu porque nao e campo.
      //
      // ATENCAO: esta rota (diferente da de simulacao) e barrada pelo allowlist
      // de IP do Pagar.me — "IP de origem nao autorizado a realizar essa
      // operacao." —, o mesmo bloqueio que o /transfers tem. Enquanto o IP de
      // saida da API nao estiver liberado, a antecipacao continua falhando, mas
      // agora falha com 401 e mensagem clara em vez de 404 silencioso. Nao tive
      // como exercitar o caminho de sucesso daqui.
      const result = await this.pagarmePost(`/recipients/${recipientId}/bulk_anticipations`, {
        payment_date: paymentDate,
        timeframe: 'start',
        requested_amount: waitingCents,
      });

      return {
        id: result.id,
        status: result.status || 'pending',
        requestedAmount: waitingCents / 100,
        approvedAmount: (result.amount || 0) / 100,
        fee: (waitingCents - (result.amount || 0)) / 100,
        createdAt: result.created_at || new Date().toISOString(),
      };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(
        `[ANTECIPACAO_INDISPONIVEL] pedido falhou para ${recipientId}: ` +
          `${JSON.stringify(errorData || err.message)}. ` +
          `O caminho ja esta no formato v5 (/bulk_anticipations); o bloqueio provavel ` +
          `e a allowlist de IP do Pagar.me, a mesma que barra o /transfers.`,
      );
      // A mensagem do provedor so e repassada quando ELE respondeu algo. Num 404
      // de rota inexistente — o caso de hoje — nao ha mensagem, e o lojista via
      // "Erro ao solicitar antecipacao", que soa como falha momentanea e convida
      // a tentar de novo para sempre. Dizer que o recurso esta indisponivel e
      // honesto e evita o retry infinito.
      throw new BadRequestException(
        errorData?.message ||
          'A antecipação está indisponível no momento. Nossa equipe já foi avisada.',
      );
    }
  }

  async updateRecipientAnticipationSettings(recipientId: string, enabled: boolean): Promise<boolean> {
    try {
      await this.pagarmePatch(`/recipients/${recipientId}/automatic-anticipation-settings`, {
        enabled,
        type: 'full',
        volume_percentage: 100,
      });
      return true;
    } catch (err: any) {
      this.logger.error(`Failed to update anticipation settings: ${JSON.stringify(err.response?.data || err.message)}`);
      throw new BadRequestException('Erro ao atualizar configurações de antecipação');
    }
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  async findByVendor(userId: string): Promise<Payment[]> {
    return this.paymentsRepository.find({
      where: { vendorUser: { id: userId } },
      order: { createdAt: 'DESC' },
    });
  }

  async findByAppUser(userId: string): Promise<Payment[]> {
    return this.paymentsRepository.find({
      where: { appUser: { id: userId } },
      order: { createdAt: 'DESC' },
    });
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<Payment[]> {
    return this.paymentsRepository.find({
      relations: ['appUser', 'vendorUser'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Totais REAIS da tabela inteira, para o cabecalho da tela financeira do
   * superadmin. Antes o painel somava client-side os 100 pagamentos que a
   * lista paginada trazia e apresentava o resultado como "Receita aprovada" —
   * com 900 pagamentos, o numero era uma fracao do real, sem nenhum aviso.
   */
  async paymentsSummary(): Promise<{
    totalCount: number;
    approvedAmount: number;
    pendingAmount: number;
  }> {
    const row = await this.paymentsRepository
      .createQueryBuilder('payment')
      .select('COUNT(*)', 'totalCount')
      .addSelect(
        `COALESCE(SUM(payment.amount) FILTER (WHERE payment.status = 'approved'), 0)`,
        'approvedAmount',
      )
      .addSelect(
        `COALESCE(SUM(payment.amount) FILTER (WHERE payment.status = 'pending'), 0)`,
        'pendingAmount',
      )
      .getRawOne();
    return {
      totalCount: parseInt(row?.totalCount ?? '0', 10),
      approvedAmount: parseFloat(row?.approvedAmount ?? '0'),
      pendingAmount: parseFloat(row?.pendingAmount ?? '0'),
    };
  }

  async platformRevenue(): Promise<number> {
    // Revenue from plan upgrades and promotions
    const paymentResult = await this.paymentsRepository
      .createQueryBuilder('payment')
      .select('COALESCE(SUM(payment.amount), 0)', 'total')
      .where('payment.status = :status', { status: 'approved' })
      // O tipo de pagamento de assinatura foi renomeado PLAN_UPGRADE -> SUBSCRIPTION
      // (+ SUBSCRIPTION_RENEWAL), mas esta query ficou pra trás e passou a somar
      // ZERO de assinaturas na receita. Inclui os tipos novos e mantém PLAN_UPGRADE
      // por causa das linhas históricas gravadas antes do rename.
      .andWhere('payment.type IN (:...types)', {
        types: ['SUBSCRIPTION', 'SUBSCRIPTION_RENEWAL', 'PLAN_UPGRADE', 'PROMOTION'],
      })
      .getRawOne();
    const paymentRevenue = parseFloat(paymentResult.total);

    // Revenue from order commissions (completed orders)
    const orderRepo = this.paymentsRepository.manager.getRepository(Order);
    const commissionResult = await orderRepo
      .createQueryBuilder('order')
      .select('COALESCE(SUM(order.commissionAmount), 0)', 'total')
      .where('order.status = :status', { status: OrderStatus.COMPLETED })
      .getRawOne();
    const commissionRevenue = parseFloat(commissionResult.total);

    return paymentRevenue + commissionRevenue;
  }

  // ─── Appointment Webhook Handlers ───────────────────────────────────────

  private async handleAppointmentPaid(appointmentId: string, pagarmeOrderId: string): Promise<void> {
    const aptRepo = this.paymentsRepository.manager.getRepository(Appointment);
    const appointment = await aptRepo.findOne({
      where: { id: appointmentId },
      relations: ['customer', 'store', 'store.owner', 'service'],
    });

    if (!appointment) {
      this.logger.warn(`Appointment not found for payment webhook: ${appointmentId}`);
      return;
    }

    if (appointment.paymentStatus !== 'AWAITING_PAYMENT') {
      this.logger.log(`Appointment ${appointment.appointmentNumber} already paid, skipping`);
      return;
    }

    // Update pagarmeOrderId if placeholder
    if (appointment.pagarmeOrderId?.startsWith('link-') && pagarmeOrderId) {
      appointment.pagarmeOrderId = pagarmeOrderId;
    }

    appointment.paymentStatus = 'PAID';
    await aptRepo.save(appointment);

    this.logger.log(`Payment confirmed for appointment ${appointment.appointmentNumber}`);

    // Notify customer
    if (appointment.customer?.id) {
      this.notificationsService.sendToAppUser(
        appointment.customer.id,
        'Pagamento confirmado!',
        `Pagamento do agendamento ${appointment.appointmentNumber} aprovado.`,
        { type: 'APPOINTMENT_PAYMENT', appointmentId: appointment.id },
      ).catch(() => {});
    }

    // Notify vendor
    if (appointment.store?.owner?.id) {
      this.notificationsService.sendToVendorUser(
        appointment.store.owner.id,
        'Pagamento recebido!',
        `${appointment.service?.name} — ${appointment.appointmentNumber} pago pelo cliente.`,
        { type: 'APPOINTMENT_PAYMENT', appointmentId: appointment.id },
      ).catch(() => {});
    }
  }

  // ─── Appointment Payments ──────────────────────────────────────────────

  async createAppointmentCheckout(
    appointment: Appointment,
    customer: AppUser,
  ): Promise<{ checkoutUrl: string; preferenceId: string }> {
    await this.ensureCustomer(customer);

    const totalCents = Math.round(Number(appointment.price) * 100);

    try {
      const body: any = {
        name: `Agendamento ${appointment.appointmentNumber}`,
        type: 'order',
        amount: totalCents,
        accepted_payment_methods: ['credit_card', 'pix'],
        payment_settings: {
          credit_card: {
            installments: [{ number: 1, total: totalCents }],
            statement_descriptor: STATEMENT_DESCRIPTOR,
          },
          pix: { expires_in: 1800 },
        },
        items: [
          {
            description: `Agendamento ${appointment.appointmentNumber}`.substring(0, 256),
            quantity: 1,
            amount: totalCents,
          },
        ],
        metadata: {
          type: 'appointment',
          appointment_id: appointment.id,
          appointment_number: appointment.appointmentNumber,
        },
      };

      const result = await this.pagarmePost('/paymentlinks', body);
      const checkoutUrl = result.url || `https://pagar.me/pay/${result.id}`;

      this.logger.log(`Pagar.me payment link for appointment ${appointment.appointmentNumber} | total: ${appointment.price}`);
      return { checkoutUrl, preferenceId: `link-${appointment.id}-${Date.now()}` };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me appointment checkout failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao criar pagamento no Pagar.me');
    }
  }

  async createAppointmentPix(
    appointment: Appointment,
    customer: AppUser,
  ): Promise<{ checkoutUrl: string; preferenceId: string; qrCode?: string; qrCodeUrl?: string }> {
    const totalCents = Math.round(Number(appointment.price) * 100);
    const phone = this.formatPhoneForPagarme(customer.phone);
    const uniqueCode = `${appointment.id}-${Date.now()}`;

    const orderBody: any = {
      code: uniqueCode,
      items: [
        {
          amount: totalCents,
          description: `Agendamento ${appointment.appointmentNumber} (PIX)`.substring(0, 256),
          quantity: 1,
          code: uniqueCode,
        },
      ],
      customer: {
        name: customer.name,
        email: customer.email,
        type: 'individual',
        document: customer.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        ...(phone ? { phones: { mobile_phone: phone } } : {}),
      },
      payments: [
        {
          payment_method: 'pix',
          pix: {
            expires_in: 1800,
            additional_information: [
              { name: 'Agendamento', value: appointment.appointmentNumber },
            ],
          },
        },
      ],
      metadata: {
        type: 'appointment',
        appointment_id: appointment.id,
        appointment_number: appointment.appointmentNumber,
      },
      closed: true,
    };

    try {
      const result = await this.pagarmePost('/orders', orderBody);
      const charge = result.charges?.[0];
      const lastTransaction = charge?.last_transaction;
      const qrCode = lastTransaction?.qr_code || '';
      const qrCodeUrl = lastTransaction?.qr_code_url || '';

      this.logger.log(`Pagar.me PIX for appointment ${appointment.appointmentNumber} | total: ${appointment.price} | pagarme_order: ${result.id}`);

      return {
        checkoutUrl: qrCodeUrl || '',
        preferenceId: result.id,
        qrCode,
        qrCodeUrl,
      };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me appointment PIX failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao criar pagamento PIX no Pagar.me');
    }
  }

  async createAppointmentDirectCharge(
    appointment: Appointment,
    customer: AppUser,
    cardId?: string,
    cardToken?: string,
  ): Promise<{ pagarmeOrderId: string; status: string; chargeId?: string }> {
    await this.ensureCustomer(customer);

    const totalCents = Math.round(Number(appointment.price) * 100);
    const phone = this.formatPhoneForPagarme(customer.phone);
    const uniqueCode = `${appointment.id}-${Date.now()}`;

    // Build card field
    let cardField: any;
    if (cardId) {
      cardField = { card_id: cardId };
    } else if (cardToken) {
      cardField = { card_token: cardToken };
    } else {
      throw new BadRequestException('Informe cardId ou cardToken');
    }

    const orderBody: any = {
      code: uniqueCode,
      items: [
        {
          amount: totalCents,
          description: `Agendamento ${appointment.appointmentNumber}`.substring(0, 256),
          quantity: 1,
          code: uniqueCode,
        },
      ],
      customer: {
        name: customer.name,
        email: customer.email,
        type: 'individual',
        document: customer.cpf?.replace(/\D/g, '') || '',
        document_type: 'CPF',
        ...(phone ? { phones: { mobile_phone: phone } } : {}),
      },
      payments: [
        {
          payment_method: 'credit_card',
          credit_card: {
            ...cardField,
            operation_type: 'pre_auth',
            installments: 1,
            statement_descriptor: STATEMENT_DESCRIPTOR,
          },
        },
      ],
      metadata: {
        type: 'appointment',
        appointment_id: appointment.id,
        appointment_number: appointment.appointmentNumber,
      },
      closed: true,
    };

    try {
      const result = await this.pagarmePost('/orders', orderBody);
      const charge = result.charges?.[0];
      const chargeId = charge?.id;
      const status = charge?.status || result.status;

      this.logger.log(`Pagar.me direct charge for appointment ${appointment.appointmentNumber} | charge: ${chargeId} | status: ${status}`);

      return { pagarmeOrderId: result.id, status, chargeId };
    } catch (err: any) {
      const errorData = err.response?.data;
      this.logger.error(`Pagar.me appointment direct charge failed: ${JSON.stringify(errorData || err.message)}`);
      throw new BadRequestException(errorData?.message || 'Erro ao processar pagamento');
    }
  }

  /**
   * Libera o dinheiro de um agendamento CANCELADO.
   *
   * Nenhuma das duas mutations de cancelamento (cliente ou lojista) tocava no
   * pagamento — so trocavam o status e notificavam. Como `create` ja cobra
   * (pre-autorizacao no cartao, PIX pago na hora), o resultado era:
   *   - CARTAO: os R$ X ficavam bloqueados no limite do cliente ate a
   *     pre-autorizacao caducar sozinha na adquirente, dias depois;
   *   - PIX: o cliente ja PAGOU de verdade, o dinheiro ficava parado na conta da
   *     plataforma, `isSettled` seguia false (o lojista tambem nao recebia) e
   *     nao existia caminho nenhum de devolucao.
   *
   * Nao lanca: o cancelamento em si nao pode falhar por causa do estorno. O erro
   * fica registrado em log para reprocessamento manual.
   */
  async releaseAppointmentPayment(appointment: Appointment): Promise<void> {
    // Ja capturado/liquidado: nao e caso de liberacao, e de estorno manual.
    if (appointment.capturedAt || appointment.isSettled) {
      this.logger.warn(
        `Agendamento ${appointment.appointmentNumber} cancelado ja com pagamento capturado — ` +
          `estorno precisa de acao manual.`,
      );
      return;
    }

    // Cartao pre-autorizado e nao capturado: basta soltar a reserva.
    if (appointment.preAuthChargeId) {
      try {
        // Era `pagarmeDelete` cru, com o resultado descartado — o mesmo ponto
        // cego que o cancelPreAuth dos pedidos tinha.
        //
        // O detalhe que torna isto pior aqui: o comentario deste metodo, logo
        // acima, descreve como BUG exatamente o estado que o silencio
        // reproduzia — "os R$ X ficavam bloqueados no limite do cliente ate a
        // pre-autorizacao caducar sozinha na adquirente, dias depois". Este
        // metodo foi escrito para resolver isso e, ao nao conferir se a soltura
        // de fato aconteceu, devolvia o cliente ao mesmo lugar sem avisar
        // ninguem. O provedor responde 200 nesta rota mesmo quando recusa.
        await this.estornarCobranca(appointment.preAuthChargeId);
        this.logger.log(
          `Pre-auth liberada no cancelamento do agendamento ${appointment.appointmentNumber}`,
        );
      } catch (err: any) {
        // Mesma separacao do cancelPreAuth: 412 do provedor e benigno (ja
        // caducou, ja foi solta); recusa dentro de um 200 e dinheiro preso no
        // cartao do cliente e precisa aparecer no monitoramento.
        //
        // Nenhum dos dois lanca: como o doc diz, o cancelamento do agendamento
        // nao pode falhar por causa do estorno.
        if (String(err?.message || '').startsWith('estorno recusado')) {
          this.logger.error(
            `[PREAUTH_NAO_LIBERADA] agendamento ${appointment.appointmentNumber} ` +
              `| charge ${appointment.preAuthChargeId} | o limite do cliente pode seguir ` +
              `preso: ${err.message}`,
          );
        } else {
          this.logger.warn(
            `Falha ao liberar pre-auth do agendamento ${appointment.appointmentNumber} ` +
              `(pode ja ter expirado): ${err.response?.data?.message || err.message}`,
          );
        }
      }
      return;
    }

    // PIX ja pago: precisa devolver.
    if (appointment.paymentStatus === 'PAID' && appointment.pagarmeOrderId) {
      try {
        const pagarmeOrder = await this.pagarmeGet(
          `/orders/${appointment.pagarmeOrderId}`,
        );
        const charge = (pagarmeOrder?.charges || []).find(
          (c: any) => c.status === 'paid' || c.status === 'captured',
        );
        if (!charge) {
          this.logger.warn(
            `Agendamento ${appointment.appointmentNumber}: nenhuma cobranca paga encontrada para estornar.`,
          );
          return;
        }
        await this.estornarCobranca(charge.id, {
          idempotencyKey: `appointment-refund-${appointment.id}`,
        });
        this.logger.log(
          `Estorno solicitado no cancelamento do agendamento ${appointment.appointmentNumber}`,
        );
      } catch (err: any) {
        this.logger.error(
          `[APPOINTMENT_REFUND_ERROR] ${appointment.appointmentNumber}: ` +
            `${err.response?.data?.message || err.message}`,
        );
      }
    }
  }

  async settleAppointmentPayment(appointment: Appointment): Promise<void> {
    // Atomic idempotency guard
    const aptRepo = this.paymentsRepository.manager.getRepository(Appointment);
    const settleResult = await aptRepo.manager.query(
      `UPDATE appointments SET "isSettled" = true WHERE id = $1 AND "isSettled" = false RETURNING id`,
      [appointment.id],
    );
    if (linhasAfetadas(settleResult) === 0) {
      this.logger.warn(`Settlement skipped for appointment ${appointment.appointmentNumber} — already settled`);
      return;
    }

    // Credit card pre-auth: capture with split
    if (appointment.paymentMethod === 'CREDIT_CARD' && appointment.preAuthChargeId && !appointment.capturedAt) {
      try {
        const totalCents = Math.round(Number(appointment.price) * 100);
        const commissionCents = Math.round((Number(appointment.commissionAmount) || 0) * 100);
        const vendorAmount = totalCents - commissionCents;
        const vendorRecipientId = appointment.store?.owner?.pagarmeRecipientId;
        const platformRecipientId = this.configService.get('PAGARME_PLATFORM_RECIPIENT_ID');

        // P2: a soma do split TEM que fechar com o total, senão o Pagar.me rejeita
        // a captura e ela re-tenta pra sempre (isSettled é resetado no catch).
        // ANTES: se o vendedor não tinha recipient mas havia comissão, o split
        // saía só com a parte da plataforma (< total) → captura travava. Agora a
        // plataforma absorve o RESTANTE (total − o que foi pro vendedor), igual ao
        // fluxo de pedidos.
        const splitRules: any[] = [];
        let vendorSplit = 0;
        if (vendorRecipientId && vendorAmount > 0) {
          vendorSplit = vendorAmount;
          splitRules.push({
            amount: vendorSplit,
            recipient_id: vendorRecipientId,
            type: 'flat',
            options: { charge_processing_fee: false, liable: false },
          });
        }
        const platformAmount = totalCents - vendorSplit;
        if (platformRecipientId && platformAmount > 0) {
          splitRules.push({
            amount: platformAmount,
            recipient_id: platformRecipientId,
            type: 'flat',
            options: { charge_processing_fee: true, liable: true },
          });
        }

        const body: any = {
          amount: totalCents,
          code: `${appointment.id.replace(/-/g, '')}-s${Date.now()}`,
          ...(splitRules.length > 0 ? { split: splitRules } : {}),
        };

        await this.pagarmePost(`/charges/${appointment.preAuthChargeId}/capture`, body);
        await aptRepo.update(appointment.id, { capturedAt: new Date() });
        this.logger.log(`Settlement for appointment ${appointment.appointmentNumber} | capture-with-split | total: ${totalCents} cents`);
      } catch (err: any) {
        this.logger.error(`Settlement failed for appointment ${appointment.appointmentNumber}: ${err.message}`);
        await aptRepo.update(appointment.id, { isSettled: false } as any);
        throw err;
      }
      return;
    }

    // PIX: manual transfer to vendor
    const vendorRecipientId = appointment.store?.owner?.pagarmeRecipientId;
    const totalCents = Math.round(Number(appointment.price) * 100);
    const commissionCents = Math.round((Number(appointment.commissionAmount) || 0) * 100);
    const vendorAmount = totalCents - commissionCents;

    if (vendorRecipientId && vendorAmount > 0) {
      try {
        const result = await this.pagarmePost(
          '/transfers',
          {
            amount: vendorAmount,
            recipient_id: vendorRecipientId,
            metadata: {
              appointment_id: appointment.id,
              appointment_number: appointment.appointmentNumber,
              type: 'service_payment',
            },
          },
          // BUGFIX: sem Idempotency-Key, qualquer re-tentativa (manual ou
          // automatica) pagaria o vendedor DUAS VEZES. O caminho de PEDIDO ja
          // usava chave deterministica (Error#2); a copia de agendamento nao foi
          // atualizada junto.
          `settle-apt-${appointment.id}-vendor`,
        );
        this.logger.log(`Transfer to vendor for appointment ${appointment.appointmentNumber} | amount: ${vendorAmount} cents | transfer: ${result.id}`);
      } catch (err: any) {
        const errorDetail = JSON.stringify(err.response?.data || err.message);

        if (PaymentsService.ehBloqueioDeOrigem(err)) {
          // MESMA CORRECAO QUE O CAMINHO DE PEDIDO JA TINHA RECEBIDO (9a79460),
          // e que nao foi aplicada nesta copia — classico conserto que pega um
          // lado so.
          //
          // Bloqueio de origem (allowlist de IP do Pagar.me) e configuracao
          // NOSSA: re-tentar nao melhora. Antes, este caminho gastava as 48h da
          // janela de retry contra um 401 que nunca muda, avisando o LOJISTA a
          // cada rodada que a transferencia dele falhou — e no fim da janela o
          // agendamento saia da fila com o dinheiro na plataforma e nenhum
          // registro de que havia divida.
          //
          // Agora o valor vira passivo rastreavel, somavel na tela de repasses
          // retidos junto com os de pedido.
          //
          // `isSettled` SEGUE FALSE: o lojista nao recebeu, e marcar como
          // liquidado esconderia a divida. O retry continua passando por aqui —
          // e por isso o log vai como ERROR com marcador proprio, para aparecer
          // no monitoramento em vez de se diluir entre falhas de rede.
          await aptRepo.update(appointment.id, {
            isSettled: false,
            vendorPayableCents: vendorAmount,
            notes: `${appointment.notes || ''}\n[VENDOR_PAYABLE] R$ ${(vendorAmount / 100).toFixed(2)} a repassar ao prestador (repasse bloqueado: allowlist de IP do Pagar.me).`.trim(),
          } as any);
          this.logger.error(
            `[REPASSE_BLOQUEADO] agendamento ${appointment.appointmentNumber} | prestador | ` +
              `${vendorAmount} centavos viraram passivo. Liberar o IP de saida no allowlist ` +
              `do Pagar.me (mesmo bloqueio da antecipacao).`,
          );
          return;
        }

        this.logger.error(`Transfer to vendor failed for appointment ${appointment.appointmentNumber}: ${errorDetail}`);
        // BUGFIX: `isSettled` foi marcado ANTES da transferencia e continuava
        // `true` mesmo com a transferencia falhando — o agendamento saia da fila
        // para sempre, o vendedor NUNCA era pago e a plataforma ficava com 100%,
        // em silencio. (O caminho de cartao logo acima ja revertia; o de PIX
        // nao.) Agora reverte para poder ser re-tentado — e a chave de
        // idempotencia acima garante que a re-tentativa nao pague duas vezes.
        await aptRepo.update(appointment.id, { isSettled: false } as any);
        if (appointment.store?.owner?.id) {
          this.notificationsService.sendToVendorUser(
            appointment.store.owner.id,
            'Falha na transferencia',
            `Transferencia do agendamento ${appointment.appointmentNumber} (R$ ${(vendorAmount / 100).toFixed(2)}) falhou. Sera re-tentada.`,
            { type: 'TRANSFER_FAILED', appointmentId: appointment.id },
          ).catch(() => {});
        }
      }
    }

    const platformKeeps = commissionCents;
    this.logger.log(`Settlement for appointment ${appointment.appointmentNumber} | platform keeps: ${platformKeeps} cents`);
  }

  // ─── Subscription Webhook Handlers ──────────────────────────────────

  private async handleSubscriptionCreated(data: any): Promise<void> {
    const subscriptionId = data.id;
    const local = await this.subscriptionsRepository.findOne({
      where: { pagarmeSubscriptionId: subscriptionId },
      relations: ['vendorUser'],
    });

    if (!local) {
      this.logger.warn(`Subscription created webhook for unknown subscription: ${subscriptionId}`);
      return;
    }

    local.status = data.status || 'active';
    if (data.current_cycle) {
      local.currentPeriodStart = data.current_cycle.start_at ? new Date(data.current_cycle.start_at) : local.currentPeriodStart;
      local.currentPeriodEnd = data.current_cycle.end_at ? new Date(data.current_cycle.end_at) : local.currentPeriodEnd;
    }
    await this.subscriptionsRepository.save(local);

    // NÃO concede o plano aqui. subscription.created dispara na CRIAÇÃO da
    // assinatura (mesmo antes do 1º pagamento em PIX/boleto), então conceder
    // aqui reabriria o mesmo furo do plano de graça. A concessão fica só no
    // invoice.paid (pagamento confirmado). Idem para não marcar o pagamento como
    // 'approved' antes da hora (a receita da plataforma soma pagamentos aprovados).

    // Notify vendor
    if (local.vendorUser?.phone) {
      this.whatsAppService.sendText(
        local.vendorUser.phone,
        `✅ *Assinatura ativada!*\n\nSua assinatura do plano ${local.plan} foi ativada com sucesso.\n\nPróxima cobrança: ${this.dataCiclo(local.currentPeriodEnd)}`,
      ).catch(() => {});
    }
    if (local.vendorUser?.id) {
      this.notificationsService.sendToVendorUser(
        local.vendorUser.id,
        'Assinatura ativada!',
        `Sua assinatura do plano ${local.plan} está ativa.`,
        { type: 'SUBSCRIPTION_ACTIVATED', subscriptionId: local.id },
      ).catch(() => {});
    }

    this.logger.log(`Subscription activated: ${subscriptionId} (${local.plan})`);
  }

  private async handleSubscriptionUpdated(data: any): Promise<void> {
    const subscriptionId = data.id;
    const local = await this.subscriptionsRepository.findOne({
      where: { pagarmeSubscriptionId: subscriptionId },
    });

    if (!local) return;

    local.status = data.status || local.status;
    if (data.current_cycle) {
      local.currentPeriodStart = data.current_cycle.start_at ? new Date(data.current_cycle.start_at) : local.currentPeriodStart;
      local.currentPeriodEnd = data.current_cycle.end_at ? new Date(data.current_cycle.end_at) : local.currentPeriodEnd;
    }
    await this.subscriptionsRepository.save(local);
    this.logger.log(`Subscription updated: ${subscriptionId} → status: ${local.status}`);
  }

  private async handleSubscriptionCanceled(data: any): Promise<void> {
    const subscriptionId = data.id;
    const local = await this.subscriptionsRepository.findOne({
      where: { pagarmeSubscriptionId: subscriptionId },
      relations: ['vendorUser'],
    });

    if (!local) return;

    local.status = 'canceled';
    local.canceledAt = new Date();
    await this.subscriptionsRepository.save(local);

    // BUGFIX: so age no vendor se ESTA for a assinatura ATUAL dele. Numa troca de
    // plano, cancelExistingSubscription cancela a sub ANTIGA e o vendor ja aponta
    // para a NOVA (ja cobrando); o webhook subscription.canceled da antiga chegava
    // aqui e — como nao tinha cancelAtPeriodEnd — rebaixava o vendor para FREE e
    // zerava o pagarmeSubscriptionId da NOVA. Idem para qualquer webhook tardio de
    // uma assinatura ja substituida. Recarrega o vendor e compara.
    const vendorAtual = local.vendorUser
      ? await this.paymentsRepository.manager
          .getRepository(VendorUser)
          .findOne({ where: { id: local.vendorUser.id } })
      : null;
    const ehAssinaturaAtual = !!vendorAtual && vendorAtual.pagarmeSubscriptionId === subscriptionId;

    if (!ehAssinaturaAtual) {
      this.logger.log(
        `Subscription canceled ${subscriptionId} nao e a atual do vendor ` +
          `${local.vendorUser?.id} (atual: ${vendorAtual?.pagarmeSubscriptionId}) — ` +
          `provavel troca de plano; sem rebaixo nem notificacao.`,
      );
      return;
    }

    // If cancel_at_period_end, keep plan until period ends; otherwise downgrade immediately
    if (!local.cancelAtPeriodEnd && local.vendorUser) {
      await this.vendorUsersService.updateVendorPlan(local.vendorUser.id, VendorPlan.FREE, 0);
      await this.paymentsRepository.manager.getRepository(VendorUser).update(local.vendorUser.id, {
        pagarmeSubscriptionId: null as any,
      });
    }

    if (local.vendorUser?.phone) {
      this.whatsAppService.sendText(
        local.vendorUser.phone,
        local.cancelAtPeriodEnd
          ? `⚠️ *Assinatura cancelada*\n\nSua assinatura do plano ${local.plan} foi cancelada. Você mantém o acesso até ${this.dataCiclo(local.currentPeriodEnd)}.`
          : `⚠️ *Assinatura cancelada*\n\nSua assinatura do plano ${local.plan} foi cancelada e seu plano foi alterado para FREE.`,
      ).catch(() => {});
    }
    if (local.vendorUser?.id) {
      this.notificationsService.sendToVendorUser(
        local.vendorUser.id,
        'Assinatura cancelada',
        local.cancelAtPeriodEnd
          ? `Sua assinatura será encerrada em ${this.dataCiclo(local.currentPeriodEnd)}.`
          : 'Sua assinatura foi cancelada e seu plano foi alterado para FREE.',
        { type: 'SUBSCRIPTION_CANCELED', subscriptionId: local.id },
      ).catch(() => {});
    }

    this.logger.log(`Subscription canceled: ${subscriptionId} (cancelAtPeriodEnd: ${local.cancelAtPeriodEnd})`);
  }

  private async handleInvoicePaid(data: any): Promise<void> {
    const subscriptionId = data.subscription?.id;
    if (!subscriptionId) {
      this.logger.warn('Invoice paid without subscription ID');
      return;
    }

    const local = await this.subscriptionsRepository.findOne({
      where: { pagarmeSubscriptionId: subscriptionId },
      relations: ['vendorUser'],
    });

    if (!local) {
      this.logger.warn(`Invoice paid for unknown subscription: ${subscriptionId}`);
      return;
    }

    // Update cycle dates
    if (data.cycle) {
      local.currentPeriodStart = data.cycle.start_at ? new Date(data.cycle.start_at) : local.currentPeriodStart;
      local.currentPeriodEnd = data.cycle.end_at ? new Date(data.cycle.end_at) : local.currentPeriodEnd;
    }
    local.status = 'active';
    await this.subscriptionsRepository.save(local);

    // Estende a validade do plano EXATAMENTE até o fim do ciclo pago (data que
    // o Pagar.me devolve). Antes convertia para meses via ceil(dias/30) e reaplicava
    // com setMonth, super-concedendo ~1 mês por ciclo em planos trimestral/anual.
    if (local.vendorUser && local.currentPeriodEnd) {
      await this.vendorUsersService.updateVendorPlan(
        local.vendorUser.id,
        local.plan,
        1,
        local.currentPeriodEnd,
      );
      // BUGFIX (defesa em profundidade): se um rebaixo na janela de renovacao
      // (scheduler) chegou a zerar o pagarmeSubscriptionId, o invoice.paid da
      // renovacao nunca o restaurava — updateSubscriptionCard passava a falhar
      // ("Nenhuma assinatura ativa") e uma troca de plano futura nao cancelava
      // esta assinatura (orfa cobrando). Reancora o vinculo na renovacao.
      await this.paymentsRepository.manager
        .getRepository(VendorUser)
        .update(local.vendorUser.id, { pagarmeSubscriptionId: subscriptionId });
    }

    // Create renewal payment record
    const invoiceAmount = data.amount ? data.amount / 100 : Number(local.amount);
    const payment = this.paymentsRepository.create({
      type: 'SUBSCRIPTION_RENEWAL',
      description: `Renovação ${local.plan} (${local.billingPeriod})`,
      amount: invoiceAmount,
      status: 'approved',
      pagarmeOrderId: data.id,
      pagarmeSubscriptionId: subscriptionId,
      pagarmeInvoiceId: data.id,
      metadata: { plan: local.plan, billingPeriod: local.billingPeriod, cycle: data.cycle?.cycle },
      vendorUser: local.vendorUser,
    });
    await this.paymentsRepository.save(payment);

    // Notify
    if (local.vendorUser?.phone) {
      this.whatsAppService.sendText(
        local.vendorUser.phone,
        `✅ *Pagamento da assinatura confirmado!*\n\nR$ ${invoiceAmount.toFixed(2)} - Plano ${local.plan}\nPróxima cobrança: ${this.dataCiclo(local.currentPeriodEnd)}`,
      ).catch(() => {});
    }
    if (local.vendorUser?.id) {
      this.notificationsService.sendToVendorUser(
        local.vendorUser.id,
        'Pagamento confirmado',
        `Sua assinatura do plano ${local.plan} foi renovada.`,
        { type: 'SUBSCRIPTION_RENEWED', subscriptionId: local.id },
      ).catch(() => {});
    }

    this.logger.log(`Invoice paid for subscription ${subscriptionId} | cycle: ${data.cycle?.cycle}`);
  }

  private async handleInvoicePaymentFailed(data: any): Promise<void> {
    const subscriptionId = data.subscription?.id;
    if (!subscriptionId) return;

    const local = await this.subscriptionsRepository.findOne({
      where: { pagarmeSubscriptionId: subscriptionId },
      relations: ['vendorUser'],
    });

    if (!local) return;

    local.status = 'past_due';
    await this.subscriptionsRepository.save(local);

    // Notify vendor to update card
    if (local.vendorUser?.phone) {
      this.whatsAppService.sendText(
        local.vendorUser.phone,
        `⚠️ *Falha no pagamento da assinatura*\n\nNão conseguimos cobrar sua assinatura do plano ${local.plan}.\n\nPor favor, atualize seu cartão de crédito no painel para evitar a suspensão do plano.`,
      ).catch(() => {});
    }
    if (local.vendorUser?.id) {
      this.notificationsService.sendToVendorUser(
        local.vendorUser.id,
        'Falha no pagamento',
        'Não conseguimos cobrar sua assinatura. Atualize seu cartão de crédito.',
        { type: 'SUBSCRIPTION_PAYMENT_FAILED', subscriptionId: local.id },
      ).catch(() => {});
    }

    this.logger.warn(`Invoice payment failed for subscription ${subscriptionId}`);
  }
}
