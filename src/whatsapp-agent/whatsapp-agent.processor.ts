import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from 'bull';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenerativeAI,
  SchemaType,
  type Part,
  type Content,
} from '@google/generative-ai';
import {
  AGENT_QUEUE,
  WahaMessagePayload,
  WhatsAppAgentService,
} from './whatsapp-agent.service';
import {
  AgentSession,
  AgentSessionStatus,
} from './entities/agent-session.entity';
import { StoresService } from '../stores/stores.service';
import { OrdersService } from '../orders/orders.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { AppUser } from '../users/entities/app-user.entity';
import { OrderStatus } from '../common/enums';

@Processor(AGENT_QUEUE)
export class WhatsAppAgentProcessor {
  private readonly logger = new Logger(WhatsAppAgentProcessor.name);
  private readonly genAI: GoogleGenerativeAI;

  constructor(
    private readonly agentService: WhatsAppAgentService,
    private readonly storesService: StoresService,
    private readonly ordersService: OrdersService,
    private readonly whatsAppService: WhatsAppService,
    private readonly configService: ConfigService,
    @InjectRepository(AppUser)
    private readonly appUsersRepository: Repository<AppUser>,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY', '');
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  @Process('process-message')
  async handleMessage(job: Job<WahaMessagePayload>) {
    const { from, body } = job.data;

    try {
      const fromNumber = from.replace(/@.*$/, '');

      // --- Routing: vendor or customer? ---
      const store = await this.storesService.findByWhatsappNumber(fromNumber);

      if (store) {
        await this.handleVendorMessage(from, fromNumber, body, store);
      } else {
        await this.handleCustomerMessage(from, fromNumber, body);
      }
    } catch (err) {
      this.logger.error(`Erro ao processar mensagem de ${from}: ${err.message}`);
      await this.whatsAppService.sendText(
        from,
        'Desculpe, ocorreu um erro. Tente novamente em instantes.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // VENDOR MODE
  // ---------------------------------------------------------------------------

  private async handleVendorMessage(
    from: string,
    fromNumber: string,
    body: string,
    store: any,
  ): Promise<void> {
    const session = await this.agentService.getOrCreateSession(fromNumber, store.id);
    if (session.status === AgentSessionStatus.BLOCKED) return;

    session.role = 'vendor';
    session.conversationHistory = [
      ...session.conversationHistory.slice(-9),
      { role: 'user', content: body, timestamp: new Date().toISOString() },
    ];

    const response = await this.runGeminiVendor(session, store);

    session.conversationHistory = [
      ...session.conversationHistory,
      { role: 'model', content: response, timestamp: new Date().toISOString() },
    ];
    await this.agentService.updateSession(session);
    await this.whatsAppService.sendText(from, response);
  }

  private async runGeminiVendor(session: AgentSession, store: any): Promise<string> {
    const systemPrompt = `Você é o assistente de gestão da loja *${store.name}* em ${store.city}/${store.state}.
Você está conversando com o VENDEDOR/DONO da loja, não com um cliente.
Sua função é ajudar o vendedor a gerenciar pedidos e acompanhar as vendas via WhatsApp.

Regras:
- Seja objetivo e direto (máximo 5 linhas por resposta)
- Responda sempre em português brasileiro
- Para listar pedidos use getPendingOrders ou getOrders
- Para confirmar/aceitar um pedido use updateOrderStatus com status ACCEPTED
- Para marcar como em preparo use PREPARING, pronto use READY, saiu para entrega DELIVERING, entregue DELIVERED
- Para cancelar use CANCELLED
- Para ver resumo do dia use getDailySummary
- Sempre confirme ações destrutivas (cancelamento) antes de executar`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [
      {
        functionDeclarations: [
          {
            name: 'getPendingOrders',
            description: 'Lista os pedidos pendentes de confirmação da loja',
            parameters: { type: SchemaType.OBJECT, properties: {} },
          },
          {
            name: 'getOrders',
            description: 'Lista pedidos da loja filtrados por status',
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                status: {
                  type: SchemaType.STRING,
                  description: 'Status do pedido: PENDING, ACCEPTED, PREPARING, READY, DELIVERING, DELIVERED, CANCELLED',
                },
              },
            },
          },
          {
            name: 'updateOrderStatus',
            description: 'Atualiza o status de um pedido',
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                orderNumber: {
                  type: SchemaType.STRING,
                  description: 'Número do pedido (ex: ORD-...)',
                },
                status: {
                  type: SchemaType.STRING,
                  description: 'Novo status: ACCEPTED, PREPARING, READY, DELIVERING, DELIVERED, CANCELLED',
                },
              },
              required: ['orderNumber', 'status'],
            },
          },
          {
            name: 'getDailySummary',
            description: 'Retorna resumo de vendas do dia',
            parameters: { type: SchemaType.OBJECT, properties: {} },
          },
        ],
      },
    ];

    return this.runGemini(session, systemPrompt, tools, (name, args) =>
      this.executeVendorTool(name, args, session.storeId),
    );
  }

  private async executeVendorTool(name: string, args: any, storeId: string): Promise<any> {
    if (name === 'getPendingOrders') {
      try {
        const orders = await this.ordersService.findByStore(storeId);
        const pending = orders.filter((o) =>
          [OrderStatus.PENDING, OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_REVIEW].includes(o.status),
        );
        if (pending.length === 0) return { message: 'Nenhum pedido pendente.' };
        return {
          count: pending.length,
          orders: pending.map((o) => ({
            orderNumber: o.orderNumber,
            status: o.status,
            customer: o.customer?.name,
            total: o.total,
            items: o.items?.map((i) => `${i.quantity}x ${i.product?.name}`).join(', '),
          })),
        };
      } catch (err) {
        return { error: err.message };
      }
    }

    if (name === 'getOrders') {
      try {
        const orders = await this.ordersService.findByStore(storeId);
        const filtered = args.status
          ? orders.filter((o) => o.status === args.status)
          : orders.slice(0, 10);
        return {
          count: filtered.length,
          orders: filtered.map((o) => ({
            orderNumber: o.orderNumber,
            status: o.status,
            customer: o.customer?.name,
            total: o.total,
          })),
        };
      } catch (err) {
        return { error: err.message };
      }
    }

    if (name === 'updateOrderStatus') {
      try {
        const order = await this.ordersService.findByOrderNumber(args.orderNumber);
        if (!order) return { error: 'Pedido não encontrado' };
        if (order.store?.id !== storeId) return { error: 'Pedido não pertence à sua loja' };

        const agentEmail = this.configService.get('AGENT_APP_USER_EMAIL', 'agente@bcmtech.com.br');
        const agentUser = await this.appUsersRepository.findOne({ where: { email: agentEmail } });
        if (!agentUser) return { error: 'Conta do agente não encontrada' };

        const updated = await this.ordersService.updateStatus(
          order.id,
          args.status as OrderStatus,
          agentUser,
        );
        return {
          success: true,
          orderNumber: updated.orderNumber,
          newStatus: updated.status,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    if (name === 'getDailySummary') {
      try {
        const orders = await this.ordersService.findByStore(storeId);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayOrders = orders.filter((o) => new Date(o.createdAt) >= today);
        const delivered = todayOrders.filter((o) => o.status === OrderStatus.DELIVERED);
        const inProgress = todayOrders.filter((o) =>
          [OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.DELIVERING].includes(o.status),
        );
        const revenue = delivered.reduce((sum, o) => sum + Number(o.total), 0);
        return {
          todayOrders: todayOrders.length,
          delivered: delivered.length,
          inProgress: inProgress.length,
          revenue: `R$${revenue.toFixed(2)}`,
        };
      } catch (err) {
        return { error: err.message };
      }
    }

    return { error: 'Tool desconhecida' };
  }

  // ---------------------------------------------------------------------------
  // CUSTOMER MODE
  // ---------------------------------------------------------------------------

  private async handleCustomerMessage(
    from: string,
    fromNumber: string,
    body: string,
  ): Promise<void> {
    // Normalize phone for lookup: keep only digits, try suffix match
    const phoneDigits = fromNumber.replace(/\D/g, '');
    const appUser = await this.appUsersRepository
      .createQueryBuilder('u')
      .where("REPLACE(REPLACE(REPLACE(u.phone, '+', ''), '-', ''), ' ', '') LIKE :suffix", {
        suffix: `%${phoneDigits.slice(-8)}`,
      })
      .getOne();

    if (!appUser) {
      await this.whatsAppService.sendText(
        from,
        'Olá! Para usar este assistente, faça seu primeiro pedido pelo aplicativo. Após isso, você poderá consultar seus pedidos aqui.',
      );
      return;
    }

    // Find most recent order to associate a store with the session
    const recentOrders = await this.ordersService.findByCustomer(appUser.id);
    const latestOrder = recentOrders[0];
    const storeId = latestOrder?.store?.id ?? 'unknown';

    const session = await this.agentService.getOrCreateSession(fromNumber, storeId);
    if (session.status === AgentSessionStatus.BLOCKED) return;

    session.role = 'customer';
    session.conversationHistory = [
      ...session.conversationHistory.slice(-9),
      { role: 'user', content: body, timestamp: new Date().toISOString() },
    ];

    const response = await this.runGeminiCustomer(session, appUser);

    session.conversationHistory = [
      ...session.conversationHistory,
      { role: 'model', content: response, timestamp: new Date().toISOString() },
    ];
    await this.agentService.updateSession(session);
    await this.whatsAppService.sendText(from, response);
  }

  private async runGeminiCustomer(session: AgentSession, appUser: AppUser): Promise<string> {
    const systemPrompt = `Você é o assistente de pedidos do *bcmTech Shopping*.
Você está conversando com o CLIENTE ${appUser.name}.
Sua função é ajudar o cliente a acompanhar e gerenciar seus pedidos.

Regras:
- Seja amigável e objetivo (máximo 5 linhas por resposta)
- Responda sempre em português brasileiro
- Para listar pedidos recentes use getMyOrders
- Para consultar status de um pedido específico use getOrderStatus
- Para cancelar um pedido use cancelOrder (apenas se status for PENDING)
- Nunca cancele pedidos já aceitos ou em preparo`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [
      {
        functionDeclarations: [
          {
            name: 'getMyOrders',
            description: 'Lista os pedidos recentes do cliente',
            parameters: { type: SchemaType.OBJECT, properties: {} },
          },
          {
            name: 'getOrderStatus',
            description: 'Consulta o status de um pedido específico',
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                orderNumber: {
                  type: SchemaType.STRING,
                  description: 'Número do pedido (ex: ORD-...)',
                },
              },
              required: ['orderNumber'],
            },
          },
          {
            name: 'cancelOrder',
            description: 'Cancela um pedido (apenas se ainda estiver PENDING)',
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                orderNumber: {
                  type: SchemaType.STRING,
                  description: 'Número do pedido a cancelar',
                },
              },
              required: ['orderNumber'],
            },
          },
        ],
      },
    ];

    return this.runGemini(session, systemPrompt, tools, (name, args) =>
      this.executeCustomerTool(name, args, appUser),
    );
  }

  private async executeCustomerTool(name: string, args: any, appUser: AppUser): Promise<any> {
    if (name === 'getMyOrders') {
      try {
        const orders = await this.ordersService.findByCustomer(appUser.id);
        const recent = orders.slice(0, 5);
        if (recent.length === 0) return { message: 'Nenhum pedido encontrado.' };
        return {
          count: recent.length,
          orders: recent.map((o) => ({
            orderNumber: o.orderNumber,
            status: o.status,
            store: o.store?.name,
            total: o.total,
            createdAt: o.createdAt,
          })),
        };
      } catch (err) {
        return { error: err.message };
      }
    }

    if (name === 'getOrderStatus') {
      try {
        const order = await this.ordersService.findByOrderNumber(args.orderNumber);
        if (!order) return { error: 'Pedido não encontrado' };
        if (order.customer?.id !== appUser.id) return { error: 'Pedido não pertence à sua conta' };
        return {
          orderNumber: order.orderNumber,
          status: order.status,
          store: order.store?.name,
          total: order.total,
          items: order.items?.map((i) => `${i.quantity}x ${i.product?.name}`).join(', '),
          createdAt: order.createdAt,
        };
      } catch (err) {
        return { error: err.message };
      }
    }

    if (name === 'cancelOrder') {
      try {
        const order = await this.ordersService.findByOrderNumber(args.orderNumber);
        if (!order) return { error: 'Pedido não encontrado' };
        if (order.customer?.id !== appUser.id) return { error: 'Pedido não pertence à sua conta' };
        if (order.status !== OrderStatus.PENDING) {
          return { error: `Pedido não pode ser cancelado. Status atual: ${order.status}` };
        }
        const updated = await this.ordersService.updateStatus(
          order.id,
          OrderStatus.CANCELLED,
          appUser,
        );
        return { success: true, orderNumber: updated.orderNumber, newStatus: updated.status };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    return { error: 'Tool desconhecida' };
  }

  // ---------------------------------------------------------------------------
  // SHARED GEMINI RUNNER
  // ---------------------------------------------------------------------------

  private async runGemini(
    session: AgentSession,
    systemPrompt: string,
    tools: any[],
    executeTool: (name: string, args: any) => Promise<any>,
  ): Promise<string> {
    const history: Content[] = session.conversationHistory
      .slice(0, -1)
      .map((m) => ({
        role: m.role,
        parts: [{ text: m.content } as Part],
      }));

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemPrompt,
      tools,
    });

    const chat = model.startChat({ history });
    const lastMessage = session.conversationHistory[session.conversationHistory.length - 1];
    const result = await chat.sendMessage(lastMessage.content);
    const response = result.response;

    const functionCall = response.functionCalls()?.[0];
    if (functionCall) {
      const toolResult = await executeTool(functionCall.name, functionCall.args);
      const followUp = await chat.sendMessage([
        {
          functionResponse: {
            name: functionCall.name,
            response: { result: toolResult },
          },
        },
      ]);
      return followUp.response.text();
    }

    return response.text();
  }
}
