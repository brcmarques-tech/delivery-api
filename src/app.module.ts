import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
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
// import { WhatsAppAgentModule } from './whatsapp-agent/whatsapp-agent.module'; // migrated to n8n
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

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        // KAN-214: synchronize:true ajusta o schema a cada boot para bater com
        // as entities — em producao isso pode gerar DDL destrutivo (drop de
        // coluna/tabela) e perda de dados silenciosa no deploy. Desligado em
        // producao; mudancas de schema em prod devem ir por migrations.
        // Continua ligado em dev para agilidade.
        const synchronize = config.get('NODE_ENV') !== 'production';
        const databaseUrl = config.get('DATABASE_URL');
        if (databaseUrl) {
          return {
            type: 'postgres',
            url: databaseUrl,
            ssl: { rejectUnauthorized: false },
            autoLoadEntities: true,
            synchronize,
          };
        }
        return {
          type: 'postgres',
          host: config.get('DB_HOST'),
          port: config.get<number>('DB_PORT'),
          username: config.get('DB_USERNAME'),
          password: config.get('DB_PASSWORD'),
          database: config.get('DB_DATABASE'),
          autoLoadEntities: true,
          synchronize,
        };
      },
      inject: [ConfigService],
    }),

    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      sortSchema: true,
      playground: true,
      subscriptions: {
        'graphql-ws': true,
      },
      context: ({ req, extra }) => ({ req: req || extra?.request }),
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
    // WhatsAppAgentModule, // migrated to n8n
    N8nAgentModule,
  ],
})
export class AppModule {}
