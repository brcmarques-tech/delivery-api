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
    const { from, to, body } = job.data;

    try {
      // Busca loja pelo número de WhatsApp
      const store = await this.storesService.findByWhatsappNumber(to);
      if (!store) {
        this.logger.warn(`Nenhuma loja encontrada para o número ${to}`);
        return;
      }

      const session = await this.agentService.getOrCreateSession(
        from,
        store.id,
      );
      if (session.status === AgentSessionStatus.BLOCKED) return;

      // Adiciona mensagem do usuário ao histórico
      session.conversationHistory = [
        ...session.conversationHistory.slice(-9),
        { role: 'user', content: body, timestamp: new Date().toISOString() },
      ];

      const response = await this.runGemini(session, store);

      // Adiciona resposta do agente ao histórico
      session.conversationHistory = [
        ...session.conversationHistory,
        {
          role: 'model',
          content: response,
          timestamp: new Date().toISOString(),
        },
      ];
      await this.agentService.updateSession(session);

      await this.whatsAppService.sendText(from, response);
    } catch (err) {
      this.logger.error(
        `Erro ao processar mensagem de ${from}: ${err.message}`,
      );
      await this.whatsAppService.sendText(
        from,
        'Desculpe, ocorreu um erro. Tente novamente em instantes.',
      );
    }
  }

  private async runGemini(session: AgentSession, store: any): Promise<string> {
    const catalog = await this.storesService.getPublicStorefront(store.id);

    const catalogText = catalog.categories
      .filter((c) => c.products.length > 0)
      .map((c) => {
        const items = c.products
          .map((p) => {
            const price = p.promotionalPrice ?? p.price;
            return `  - ${p.name}: R$${price.toFixed(2)}${p.description ? ` (${p.description})` : ''}`;
          })
          .join('\n');
        return `*${c.name}*\n${items}`;
      })
      .join('\n\n');

    const systemPrompt = `Você é o assistente de pedidos da loja *${store.name}* em ${store.city}/${store.state}.
Horário de entrega: ${store.deliveryStartTime || '00:00'} às ${store.deliveryEndTime || '23:59'}.
Frete: R$${Number(store.deliveryFee).toFixed(2)}. Pedido mínimo: R$${Number(store.minimumOrder).toFixed(2)}.
${store.freeDelivery ? 'Entrega GRÁTIS!' : ''}

Cardápio disponível:
${catalogText}

Regras:
- Só aceite produtos do cardápio acima
- Sempre confirme o resumo completo (itens + total + frete) antes de criar o pedido
- Após confirmação do cliente, use a tool createOrder
- Seja simpático e objetivo (máximo 4 linhas por resposta)
- Responda sempre em português brasileiro
- Se o cliente perguntar sobre status de um pedido, use getOrderStatus`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [
      {
        functionDeclarations: [
          {
            name: 'createOrder',
            description: 'Cria um pedido após confirmação do cliente',
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                items: {
                  type: SchemaType.ARRAY,
                  description: 'Lista de itens do pedido',
                  items: {
                    type: SchemaType.OBJECT,
                    properties: {
                      productId: { type: SchemaType.STRING },
                      quantity: { type: SchemaType.NUMBER },
                    },
                    required: ['productId', 'quantity'],
                  },
                },
                deliveryAddress: {
                  type: SchemaType.STRING,
                  description: 'Endereço completo de entrega',
                },
                notes: {
                  type: SchemaType.STRING,
                  description: 'Observações do pedido (opcional)',
                },
              },
              required: ['items', 'deliveryAddress'],
            },
          },
          {
            name: 'getOrderStatus',
            description: 'Consulta o status de um pedido pelo número',
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                orderNumber: {
                  type: SchemaType.STRING,
                  description: 'Número do pedido',
                },
              },
              required: ['orderNumber'],
            },
          },
        ],
      },
    ];

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
    const lastMessage =
      session.conversationHistory[session.conversationHistory.length - 1];
    const result = await chat.sendMessage(lastMessage.content);
    const response = result.response;

    // Verifica se o Gemini quer chamar uma tool
    const functionCall = response.functionCalls()?.[0];
    if (functionCall) {
      const toolResult = await this.executeTool(
        functionCall.name,
        functionCall.args,
        session,
        store,
      );
      // Envia resultado da tool de volta ao Gemini para gerar resposta final
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

  private async executeTool(
    name: string,
    args: any,
    session: AgentSession,
    store: any,
  ): Promise<any> {
    if (name === 'createOrder') {
      try {
        const agentEmail =
          this.configService.get('AGENT_APP_USER_EMAIL') ||
          'agente@bcmtech.com.br';
        const agentUser = await this.appUsersRepository.findOne({
          where: { email: agentEmail },
        });
        if (!agentUser) throw new Error('Conta do agente não encontrada');

        const order = await this.ordersService.create(
          {
            storeId: store.id,
            items: args.items.map((i: any) => ({
              productId: i.productId,
              quantity: i.quantity,
            })),
            deliveryAddress: args.deliveryAddress,
            notes: args.notes,
            paymentMethod: 'ON_DELIVERY',
          },
          agentUser,
        );

        session.pendingOrderData = null;
        session.status = AgentSessionStatus.ACTIVE;
        await this.agentService.updateSession(session);

        return {
          success: true,
          orderNumber: order.orderNumber,
          orderId: order.id,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    if (name === 'getOrderStatus') {
      try {
        const order = await this.ordersService.findByOrderNumber(
          args.orderNumber,
        );
        if (!order) return { found: false };
        return {
          found: true,
          orderNumber: order.orderNumber,
          status: order.status,
          total: order.total,
        };
      } catch {
        return { found: false };
      }
    }

    return { error: 'Tool desconhecida' };
  }
}
