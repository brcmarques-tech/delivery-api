import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ThrottlerModule } from '@nestjs/throttler';
import depthLimit from 'graphql-depth-limit';
import { verify as jwtVerify } from 'jsonwebtoken'; // KAN-253
import { join } from 'path';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { StoresModule } from './stores/stores.module';
import { ProductsModule } from './products/products.module';
import { CategoriesModule } from './categories/categories.module';
import { ServicesModule } from './services/services.module';
import { SchedulesModule } from './schedules/schedules.module';
import { OrdersModule } from './orders/orders.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { AddressesModule } from './addresses/addresses.module';
import { DatabaseModule } from './database/database.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MailModule } from './mail/mail.module';
import { UploadModule } from './upload/upload.module';
import { PromotionsModule } from './promotions/promotions.module';
import { PaymentsModule } from './payments/payments.module';
import { PlatformConfigModule } from './config/platform-config.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PubSubModule } from './pubsub/pubsub.module';
import { CouponsModule } from './coupons/coupons.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { CartModule } from './cart/cart.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { RatingsModule } from './ratings/ratings.module';
import { SiteConfigModule } from './site-config/site-config.module';
// KAN-253: WhatsAppAgentModule foi migrado para o n8n e a pasta
// src/whatsapp-agent/ (5 arquivos) foi removida — ficava so confundindo sobre
// qual agente esta ativo. O agente em uso e o N8nAgentModule abaixo.
import { N8nAgentModule } from './n8n-agent/n8n-agent.module';

@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
  ],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Input#1 / A#4: base do rate limiting. O guard só é aplicado (escopado) nas
    // mutations de auth (login/registro/OTP) — ver auth.resolver — para não
    // contar cada field resolver do GraphQL contra o limite.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        // KAN-214: synchronize:true ajusta o schema a cada boot para bater com
        // as entities — em producao isso pode gerar DDL destrutivo (drop de
        // coluna/tabela) e perda de dados silenciosa no deploy. Desligado em
        // producao; mudancas de schema em prod devem ir por migrations.
        // Continua ligado em dev para agilidade.
        const isProduction = config.get('NODE_ENV') === 'production';
        const synchronize = !isProduction;

        // KAN-261: o KAN-214 desligou o `synchronize` em producao — certo, ele
        // podia gerar DDL destrutivo no deploy —, mas o projeto nao tinha
        // NENHUMA migration. Na pratica isso significava que nenhuma mudanca de
        // schema chegava a producao: nem coluna nova, nem indice.
        //
        // Agora as migrations de `src/migrations/` sao aplicadas no boot em
        // producao. Da para desligar com `RUN_MIGRATIONS=false` se algum dia
        // voce preferir aplicar manualmente antes de subir a aplicacao.
        const migrationsRun =
          isProduction && config.get('RUN_MIGRATIONS') !== 'false';

        const common = {
          autoLoadEntities: true,
          synchronize,
          migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
          migrationsRun,
        };

        const databaseUrl = config.get('DATABASE_URL');
        if (databaseUrl) {
          return {
            type: 'postgres' as const,
            url: databaseUrl,
            ssl: { rejectUnauthorized: false },
            ...common,
          };
        }
        return {
          type: 'postgres' as const,
          host: config.get<string>('DB_HOST'),
          port: config.get<number>('DB_PORT'),
          username: config.get<string>('DB_USERNAME'),
          password: config.get<string>('DB_PASSWORD'),
          database: config.get<string>('DB_DATABASE'),
          ...common,
        };
      },
      inject: [ConfigService],
    }),

    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      // forRootAsync (era forRoot) so para injetar o DataSource: o handshake do
      // WebSocket precisa consultar o banco para saber se a conta foi banida ou
      // se a sessao foi rotacionada — ver o bloco de revogacao no onConnect.
      inject: [DataSource],
      useFactory: (dataSource: DataSource) => ({
      driver: ApolloDriver,
      autoSchemaFile: true,
      sortSchema: true,
      // Input#1: limite de profundidade contra DoS por query aninhada nas relações
      // cíclicas (store → products → store → owner → ...). 12 níveis cobrem as
      // queries reais do app com folga.
      validationRules: [depthLimit(12)],
      // KAN-228: playground e introspection ficavam ligados incondicionalmente,
      // inclusive em producao — qualquer um baixava o schema inteiro da API
      // (todo o modelo de dados e mutations) e tinha uma IDE pronta pra
      // explorar. Agora so fora de producao.
      playground: process.env.NODE_ENV !== 'production',
      introspection: process.env.NODE_ENV !== 'production',
      // KAN-253: a conexao WebSocket nao era autenticada de forma alguma — o
      // filtro das subscriptions era so por argumento. Um cliente anonimo podia
      // assinar `sessionKicked` de um userId conhecido e inferir eventos de
      // login/expulsao daquela conta.
      //
      // Agora o token do handshake e validado e o usuario fica disponivel no
      // contexto (`extra.user`), abrindo caminho para guards por subscription.
      //
      // A REJEICAO de conexoes sem token fica atras de `REQUIRE_WS_AUTH=true`.
      // Default desligado de proposito: derrubar o WS quebra o tempo real do
      // app (pedidos e entregas). Ligue depois de validar com o app mobile.
      subscriptions: {
        'graphql-ws': {
          onConnect: async (context: any) => {
            const params = context.connectionParams || {};
            const raw: string =
              params.authorization || params.Authorization || '';
            const token = raw.replace(/^Bearer\s+/i, '').trim();
            const secret = process.env.JWT_SECRET;

            let user: any = null;
            if (token && secret) {
              try {
                user = jwtVerify(token, secret);
              } catch {
                user = null; // token invalido/expirado
              }
            }

            if (!user && process.env.REQUIRE_WS_AUTH === 'true') {
              throw new Error('Unauthorized: token ausente ou invalido');
            }

            // O jwtVerify acima confere so assinatura e expiracao. A revogacao
            // (isActive e sessionToken) mora na JwtStrategy, e as subscriptions
            // que filtram apenas por `wsUser` — orderCreated, orderUpdated,
            // deliveryUpdated, sessionKicked — nunca passam por ela. Resultado:
            // um lojista banido por fraude continuava recebendo, em tempo real,
            // os pedidos com nome, telefone e endereco dos clientes ate o JWT
            // expirar (7 dias). Pior no filtro de superadmin, que le o `role` do
            // claim congelado: um superadmin rebaixado seguia recebendo TODOS os
            // pedidos da plataforma.
            if (user?.sub) {
              const tabela =
                user.userType === 'vendor' ? 'vendor_users' : 'app_users';
              try {
                const linhas = await dataSource.query(
                  `SELECT "isActive", "sessionToken", role FROM ${tabela} WHERE id = $1`,
                  [user.sub],
                );
                const conta = linhas?.[0];
                const revogado =
                  !conta ||
                  conta.isActive === false ||
                  (conta.sessionToken &&
                    user.sessionToken !== conta.sessionToken);
                if (revogado) {
                  throw new Error('Unauthorized: sessao revogada');
                }
                // `role` tambem sai do banco: o claim fica congelado no token.
                user = { ...user, role: conta.role };
              } catch (err: any) {
                if (String(err?.message).startsWith('Unauthorized')) throw err;
                // Falha de banco no handshake: nao autentica, mas nao derruba a
                // conexao anonima (mesma postura do REQUIRE_WS_AUTH).
                user = null;
              }
            }

            // Disponibiliza para os resolvers de subscription. O token cru
            // tambem vai junto: o GqlAuthGuard precisa dele para rodar a
            // JwtStrategy (que valida isActive e sessionToken) — sobre WS o
            // header Authorization nao existe, o token vem em connectionParams.
            context.extra = { ...(context.extra || {}), user, wsToken: token };
            return true;
          },
        },
      },
      context: ({ req, extra }) => ({
        req: req || extra?.request,
        // KAN-253: usuario autenticado do WebSocket, quando houver.
        wsUser: extra?.user ?? null,
        wsToken: extra?.wsToken ?? null,
      }),
      }),
    }),

    PubSubModule,
    AuthModule,
    UsersModule,
    StoresModule,
    ProductsModule,
    CategoriesModule,
    ServicesModule,
    SchedulesModule,
    OrdersModule,
    DeliveriesModule,
    AddressesModule,
    DatabaseModule,
    DashboardModule,
    MailModule,
    UploadModule,
    PromotionsModule,
    PaymentsModule,
    PlatformConfigModule,
    NotificationsModule,
    CouponsModule,
    WhatsAppModule,
    CartModule,
    AppointmentsModule,
    RatingsModule,
    SiteConfigModule,
    N8nAgentModule,
  ],
})
export class AppModule {}
