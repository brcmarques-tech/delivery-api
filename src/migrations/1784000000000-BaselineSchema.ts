import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * BASELINE DO SCHEMA — KAN-283 [MÉDIO]
 *
 * O PROBLEMA QUE ISTO FECHA: nenhuma das 27 tabelas tinha CREATE TABLE em
 * migration. O schema existia porque o `synchronize` o criou em dev/antes do
 * KAN-214, e as migrations seguintes só adicionavam índice e coluna,
 * pressupondo as tabelas prontas. Consequência: `migration:run` num banco
 * VAZIO falhava na primeira migration, e produção era irreconstituível —
 * qualquer disaster recovery ou ambiente novo dependia do snapshot do
 * Lightsail. Um snapshot não é um schema versionado.
 *
 * O timestamp é propositalmente ANTERIOR ao da primeira migration existente
 * (1784870000000), para esta rodar primeiro.
 *
 * TODA instrução é idempotente (IF NOT EXISTS, ou bloco que engole
 * duplicate_object). Isso não é capricho: num banco que já tem o schema —
 * o snapshot de produção — uma baseline que estourasse abortaria o
 * `migrationsRun` do boot e derrubaria a API inteira. Que é exatamente o
 * risco que o KAN-283 levantou sobre a migration de cupom.
 *
 * GERADA por `typeorm migration:generate` contra um banco vazio (16/10/2026)
 * e depois tornada idempotente. Provada em
 * `scripts/provas/ensaia-baseline-do-schema.mjs`: banco vazio -> as 14
 * migrations -> schema idêntico, tabela por coluna, ao que o synchronize
 * produz a partir das entidades.
 */

export class BaselineSchema1784000000000 implements MigrationInterface {
    name = 'BaselineSchema1784000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Os defaults das PKs usam uuid_generate_v4(): sem a extension,
        // o CREATE TABLE falha num banco novo. Em producao ela ja existe
        // (o synchronize a criou), por isso o IF NOT EXISTS.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "site_config" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "key" character varying NOT NULL, "value" text NOT NULL DEFAULT '', "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_2bbe726c0ac935a84e78f7e33ec" UNIQUE ("key"), CONSTRAINT "PK_2a10b0ffcbef4a90bbd034e356c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "imageUrl" character varying, "sortOrder" integer NOT NULL DEFAULT '0', "isActive" boolean NOT NULL DEFAULT true, "requiresAgeVerification" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "storeId" uuid, CONSTRAINT "PK_24dbc6126a28ff948da33e97d3b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_fa6ba3528de12e174b163c09fd" ON "categories" ("storeId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "products" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "description" character varying, "price" numeric(10,2) NOT NULL, "promotionalPrice" numeric(10,2), "imageUrl" character varying, "isAvailable" boolean NOT NULL DEFAULT true, "isActive" boolean NOT NULL DEFAULT true, "stock" integer NOT NULL DEFAULT '0', "unit" character varying, "barcode" character varying, "isVariableWeight" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP, "storeId" uuid, "categoryId" uuid, CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_782da5e50e94b763eb63225d69" ON "products" ("storeId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ff56834e735fa78a15d0cf2192" ON "products" ("categoryId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "services" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "description" character varying, "price" numeric(10,2), "estimatedDuration" integer NOT NULL DEFAULT '60', "imageUrl" character varying, "isAvailable" boolean NOT NULL DEFAULT true, "isActive" boolean NOT NULL DEFAULT true, "requiresQuote" boolean NOT NULL DEFAULT false, "storeId" uuid NOT NULL, "categoryId" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ba2d347a3168a296416c6c5ccb2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ee1c9f2a1a11b2ca0c9a24c297" ON "services" ("storeId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_034b52310c2d211bc979c3cc4e" ON "services" ("categoryId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "order_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "quantity" integer NOT NULL, "unitPrice" numeric(10,2) NOT NULL, "totalPrice" numeric(10,2) NOT NULL, "notes" character varying, "weightGrams" integer, "orderId" uuid, "productId" uuid, CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_f1d359a55923bb45b057fbdab0" ON "order_items" ("orderId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cdb99c05982d5191ac8465ac01" ON "order_items" ("productId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "deliveries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "currentLatitude" numeric(10,7), "currentLongitude" numeric(10,7), "pickedUpAt" TIMESTAMP, "deliveredAt" TIMESTAMP, "payoutStatus" character varying, "payoutAmount" numeric(10,2), "payoutMpId" character varying, "vendorPayoutStatus" character varying, "vendorPayoutAmount" numeric(10,2), "vendorPayoutMpId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "delivererId" uuid, "orderId" uuid, CONSTRAINT "REL_f7433e3639e213f901e22cf864" UNIQUE ("orderId"), CONSTRAINT "PK_a6ef225c5c5f0974e503bfb731f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_5e2c4897f6f6fe0eddb9bdbada" ON "deliveries" ("delivererId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "coupons" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying NOT NULL, "discountType" character varying NOT NULL DEFAULT 'PERCENT', "discountValue" numeric(10,2) NOT NULL, "minimumOrder" numeric(10,2), "maxDiscount" numeric(10,2), "maxUses" integer NOT NULL DEFAULT '0', "usesCount" integer NOT NULL DEFAULT '0', "isActive" boolean NOT NULL DEFAULT true, "expiresAt" TIMESTAMP, "storeId" uuid NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_coupons_code_store" UNIQUE ("code", "storeId"), CONSTRAINT "PK_d7ea8864a0150183770f3e9a8cb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_1759bf86967840352d952797ed" ON "coupons" ("storeId") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "public"."orders_status_enum" AS ENUM('AWAITING_PAYMENT', 'PAYMENT_REVIEW', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'VENDOR_CONFIRMED_PICKUP', 'PICKED_UP', 'DELIVERING', 'DELIVERER_CONFIRMED_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'DISPUTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderNumber" character varying NOT NULL, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'PENDING', "subtotal" numeric(10,2) NOT NULL, "deliveryFee" numeric(10,2) NOT NULL, "total" numeric(10,2) NOT NULL, "paymentMethod" character varying, "checkoutUrl" character varying, "mpPreferenceId" character varying, "pixQrCode" character varying, "pixQrCodeBase64" character varying, "isPickup" boolean NOT NULL DEFAULT false, "commissionPercent" numeric(5,2), "commissionAmount" numeric(10,2), "notes" character varying, "deliveryAddress" character varying, "deliveryLatitude" numeric(10,7), "deliveryLongitude" numeric(10,7), "couponCode" character varying, "discount" numeric(10,2), "customerConfirmedAt" TIMESTAMP, "vendorConfirmedPickupAt" TIMESTAMP, "delivererConfirmedDeliveryAt" TIMESTAMP, "completedAt" TIMESTAMP, "disputedAt" TIMESTAMP, "disputeReason" character varying, "disputeResolution" character varying, "disputeResolvedAt" TIMESTAMP, "rejectedAt" TIMESTAMP, "rejectionReason" character varying, "estimatedPickupEta" TIMESTAMP, "estimatedDeliveryEta" TIMESTAMP, "preAuthChargeId" character varying, "capturedAt" TIMESTAMP, "isSettled" boolean NOT NULL DEFAULT false, "settledViaSplit" boolean NOT NULL DEFAULT false, "vendorSettledAt" TIMESTAMP, "delivererSettledAt" TIMESTAMP, "delivererPayableCents" integer, "delivererPayablePaidAt" TIMESTAMP, "vendorPayableCents" integer, "vendorPayablePaidAt" TIMESTAMP, "onlinePaidTotal" numeric(10,2), "overpaidRefundedAt" TIMESTAMP, "couponCredited" boolean NOT NULL DEFAULT false, "stockRestoredAt" TIMESTAMP, "codigoVendedor" character varying(6), "codigoEntregador" character varying(6), "codigoCliente" character varying(6), "codigoVendedorUsadoEm" TIMESTAMP, "codigoEntregadorUsadoEm" TIMESTAMP, "codigoClienteUsadoEm" TIMESTAMP, "codigoVendedorLat" numeric(10,7), "codigoVendedorLng" numeric(10,7), "codigoClienteLat" numeric(10,7), "codigoClienteLng" numeric(10,7), "codigoTentativas" integer NOT NULL DEFAULT '0', "codigoBloqueadoAte" TIMESTAMP, "entregaSemCodigoEm" TIMESTAMP, "entregaSemCodigoMotivo" character varying(300), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "customerId" uuid, "storeId" uuid, "couponId" uuid, CONSTRAINT "UQ_59b0c3b34ea0fa5562342f24143" UNIQUE ("orderNumber"), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_775c9f06fc27ae3ff8fb26f2c4" ON "orders" ("status") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_e5de51ca888d8b1f5ac25799dd" ON "orders" ("customerId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_0f82354e5b05fd87884eff3a7b" ON "orders" ("storeId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_c26db6c65929ecfeab91073e80" ON "orders" ("couponId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "addresses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "street" character varying NOT NULL, "number" character varying NOT NULL, "complement" character varying, "neighborhood" character varying NOT NULL, "city" character varying NOT NULL, "state" character varying NOT NULL, "zipCode" character varying NOT NULL, "latitude" numeric(10,7) NOT NULL, "longitude" numeric(10,7) NOT NULL, "isDefault" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "userId" uuid, CONSTRAINT "PK_745d8f43d3af10ab8247465e450" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_95c93a584de49f0b0e13f75363" ON "addresses" ("userId") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "public"."app_users_role_enum" AS ENUM('CUSTOMER', 'VENDOR', 'DELIVERER', 'SUPERADMIN', 'ADMIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "app_users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "email" character varying NOT NULL, "password" character varying, "googleId" character varying, "phone" character varying NOT NULL, "role" "public"."app_users_role_enum" NOT NULL DEFAULT 'CUSTOMER', "isActive" boolean NOT NULL DEFAULT true, "avatarUrl" character varying, "cpf" character varying, "vehicleType" character varying, "vehiclePlate" character varying, "profilePhotoUrl" character varying, "identityPhotoUrl" character varying, "identityPhotoBackUrl" character varying, "birthDate" character varying, "cnhNumber" character varying, "isDeliverer" boolean NOT NULL DEFAULT false, "pendingRole" character varying, "approvedAt" TIMESTAMP, "rejectedAt" TIMESTAMP, "rejectionReason" character varying, "emailVerified" boolean NOT NULL DEFAULT false, "phoneVerified" boolean NOT NULL DEFAULT false, "acceptedTermsAt" TIMESTAMP, "sessionToken" character varying, "sessionActive" boolean NOT NULL DEFAULT false, "expoPushToken" character varying, "pagarmeRecipientId" character varying, "pagarmeCustomerId" character varying, "mpConnected" boolean NOT NULL DEFAULT false, "resetPasswordToken" character varying, "resetPasswordExpires" TIMESTAMP, "permissions" jsonb, "notificationEmail" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_14241fb016a330600a7e0efae93" UNIQUE ("email"), CONSTRAINT "PK_9b97e4fbff9c2f3918fda27f999" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_app_users_cpf" ON "app_users" ("cpf") WHERE "cpf" IS NOT NULL`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "public"."appointments_status_enum" AS ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW', 'QUOTE_REQUESTED', 'QUOTED', 'QUOTE_ACCEPTED', 'QUOTE_REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "appointments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "appointmentNumber" character varying NOT NULL, "customerId" uuid NOT NULL, "storeId" uuid NOT NULL, "serviceId" uuid NOT NULL, "scheduledDate" character varying NOT NULL, "scheduledTime" character varying NOT NULL, "endTime" character varying NOT NULL, "status" "public"."appointments_status_enum" NOT NULL DEFAULT 'PENDING', "price" numeric(10,2), "notes" character varying, "address" character varying, "latitude" numeric(10,7), "longitude" numeric(10,7), "paymentMethod" character varying, "paymentStatus" character varying DEFAULT 'PENDING', "checkoutUrl" character varying, "pagarmeOrderId" character varying, "pixQrCode" character varying, "pixQrCodeBase64" character varying, "preAuthChargeId" character varying, "capturedAt" TIMESTAMP, "isSettled" boolean NOT NULL DEFAULT false, "vendorPayableCents" integer, "vendorPayablePaidAt" TIMESTAMP, "commissionAmount" numeric(10,2), "quoteDescription" text, "quoteResponse" text, "reminderSent" boolean NOT NULL DEFAULT false, "deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4a437a9a27e948726b8bb3e36ad" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_60dbcf20669c096d319e20fca8" ON "appointments" ("customerId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_be987791dec56a5566fcfd4eb4" ON "appointments" ("storeId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_f77953c373efb8ab146d98e90c" ON "appointments" ("serviceId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "stores" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "slug" character varying, "description" character varying, "logoUrl" character varying, "bannerUrl" character varying, "phone" character varying NOT NULL, "whatsappNumber" character varying, "street" character varying NOT NULL, "number" character varying NOT NULL, "complement" character varying, "neighborhood" character varying NOT NULL, "city" character varying NOT NULL, "state" character varying NOT NULL, "zipCode" character varying NOT NULL, "latitude" numeric(10,7) NOT NULL, "longitude" numeric(10,7) NOT NULL, "isOpen" boolean NOT NULL DEFAULT true, "isActive" boolean NOT NULL DEFAULT true, "storeType" character varying NOT NULL DEFAULT 'PRODUCTS', "hasOwnDelivery" boolean NOT NULL DEFAULT false, "freeDelivery" boolean NOT NULL DEFAULT false, "deliveryFee" numeric(10,2) NOT NULL DEFAULT '0', "estimatedDeliveryMinutes" integer NOT NULL DEFAULT '30', "minimumOrder" numeric(10,2) NOT NULL DEFAULT '0', "deliveryStartTime" character varying, "deliveryEndTime" character varying, "freeDeliveryAbove" numeric(10,2), "verificationLevel" character varying NOT NULL DEFAULT 'NONE', "verificationScore" integer NOT NULL DEFAULT '0', "totalSales" integer NOT NULL DEFAULT '0', "totalProducts" integer NOT NULL DEFAULT '0', "badgeClaimCount" integer NOT NULL DEFAULT '0', "lastClaimedScore" integer NOT NULL DEFAULT '0', "freePromoDaysCredit" integer NOT NULL DEFAULT '0', "commissionReductionPercent" numeric(5,2) NOT NULL DEFAULT '0', "commissionReductionExpiresAt" TIMESTAMP, "deleteToken" character varying, "deleteTokenExpires" TIMESTAMP, "lastAppointmentNumber" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "ownerId" uuid, CONSTRAINT "UQ_790b2968701a6ff5ff383237765" UNIQUE ("slug"), CONSTRAINT "UQ_a98a6bd01836ffd0fac95c12bd9" UNIQUE ("whatsappNumber"), CONSTRAINT "PK_7aa6e7d71fa7acdd7ca43d7c9cb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_a447ba082271c05997a61df26d" ON "stores" ("ownerId") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "public"."vendor_users_role_enum" AS ENUM('CUSTOMER', 'VENDOR', 'DELIVERER', 'SUPERADMIN', 'ADMIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "public"."vendor_users_vendorplan_enum" AS ENUM('FREE', 'PRO', 'PREMIUM', 'ENTERPRISE', 'CUSTOM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "vendor_users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "email" character varying NOT NULL, "password" character varying, "googleId" character varying, "phone" character varying NOT NULL, "role" "public"."vendor_users_role_enum" NOT NULL DEFAULT 'VENDOR', "isActive" boolean NOT NULL DEFAULT true, "avatarUrl" character varying, "cpf" character varying, "pendingRole" character varying, "approvedAt" TIMESTAMP, "rejectedAt" TIMESTAMP, "rejectionReason" character varying, "emailVerified" boolean NOT NULL DEFAULT false, "phoneVerified" boolean NOT NULL DEFAULT false, "acceptedTermsAt" TIMESTAMP, "acceptedSubscriptionTermsAt" TIMESTAMP, "vendorPlan" "public"."vendor_users_vendorplan_enum", "planExpiresAt" TIMESTAMP, "sessionToken" character varying, "sessionActive" boolean NOT NULL DEFAULT false, "expoPushToken" character varying, "pagarmeRecipientId" character varying, "pagarmeSubscriptionId" character varying, "pagarmeCustomerId" character varying, "mpConnected" boolean NOT NULL DEFAULT false, "resetPasswordToken" character varying, "resetPasswordExpires" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_3e6df402615dc0885bbd2d7cfef" UNIQUE ("email"), CONSTRAINT "PK_ec10229be4232e8985c794507c9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_vendor_users_cpf" ON "vendor_users" ("cpf") WHERE "cpf" IS NOT NULL`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "approval_log" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" character varying NOT NULL, "userName" character varying NOT NULL, "userEmail" character varying NOT NULL, "userType" character varying NOT NULL, "action" character varying NOT NULL, "role" character varying NOT NULL, "reason" character varying, "adminId" character varying, "profilePhotoUrl" character varying, "identityPhotoUrl" character varying, "identityPhotoBackUrl" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e59314aae80635feb9f4b4d882d" PRIMARY KEY ("id")); COMMENT ON COLUMN "approval_log"."userType" IS 'app or vendor'; COMMENT ON COLUMN "approval_log"."action" IS 'APPROVED or REJECTED'; COMMENT ON COLUMN "approval_log"."role" IS 'Role being approved/rejected (DELIVERER, VENDOR, etc)'`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "store_follows" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "userId" uuid, "storeId" uuid, CONSTRAINT "UQ_0dbcacc611079d1ca673d12b8bd" UNIQUE ("userId", "storeId"), CONSTRAINT "PK_eebb7a3a792e56f21621396ac17" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_f0efa141f718dec773bf42687f" ON "store_follows" ("userId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_fa87e4569e2cd489d5cd57d9ab" ON "store_follows" ("storeId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "schedules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "storeId" uuid NOT NULL, "dayOfWeek" integer NOT NULL, "startTime" character varying NOT NULL, "endTime" character varying NOT NULL, "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_3e96ef054a23eef88608119179e" UNIQUE ("storeId", "dayOfWeek"), CONSTRAINT "PK_7e33fc2ea755a5765e3564e66dd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_8ba0dbc7ec71486e5491bff6b1" ON "schedules" ("storeId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "service_ratings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "rating" integer NOT NULL, "comment" text, "photoUrls" jsonb, "customerId" uuid NOT NULL, "storeId" uuid NOT NULL, "serviceId" uuid NOT NULL, "appointmentId" uuid NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_f6b2587f79f584a1c163b6dccf4" UNIQUE ("appointmentId"), CONSTRAINT "PK_8969d63e24f8d58c96952fa1346" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ade087917eb023bc4516a1db7d" ON "service_ratings" ("customerId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ed55e888ef6797bbfc3bd6e396" ON "service_ratings" ("storeId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_58849e8c0ea7fd3f8892836c1d" ON "service_ratings" ("serviceId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_f6b2587f79f584a1c163b6dccf" ON "service_ratings" ("appointmentId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "promotions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "title" character varying NOT NULL, "description" character varying, "imageUrl" character varying, "startDate" TIMESTAMP NOT NULL, "endDate" TIMESTAMP NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "promotionalPrice" numeric(10,2) NOT NULL, "adCost" numeric(10,2) NOT NULL DEFAULT '0', "price" numeric(10,2), "isPaid" boolean NOT NULL DEFAULT false, "checkoutUrl" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "storeId" uuid, "productId" uuid, CONSTRAINT "PK_380cecbbe3ac11f0e5a7c452c34" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_32bb72bb5f508d4aa02f215a58" ON "promotions" ("storeId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_c8147b5d9ff0dfa7e37be56c1b" ON "promotions" ("productId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "webhook_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "eventKey" character varying NOT NULL, "processedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_0effa251ae3fc10d598c08c8a8e" UNIQUE ("eventKey"), CONSTRAINT "PK_4cba37e6a0acb5e1fc49c34ebfd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_0effa251ae3fc10d598c08c8a8" ON "webhook_events" ("eventKey") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "public"."subscriptions_plan_enum" AS ENUM('FREE', 'PRO', 'PREMIUM', 'ENTERPRISE', 'CUSTOM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "subscriptions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "pagarmeSubscriptionId" character varying NOT NULL, "pagarmePlanId" character varying NOT NULL, "pagarmeCustomerId" character varying NOT NULL, "plan" "public"."subscriptions_plan_enum" NOT NULL, "billingPeriod" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "currentPeriodStart" TIMESTAMP, "currentPeriodEnd" TIMESTAMP, "canceledAt" TIMESTAMP, "cancelAtPeriodEnd" boolean NOT NULL DEFAULT false, "amount" numeric(10,2) NOT NULL, "installments" integer NOT NULL DEFAULT '1', "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "vendorUserId" uuid, CONSTRAINT "UQ_45307c12cf7fd37010ff2ad53b1" UNIQUE ("pagarmeSubscriptionId"), CONSTRAINT "PK_a87248d73155605cf782be9ee5e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_b5a470e3f438c1ebcb1bf15a78" ON "subscriptions" ("vendorUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_45307c12cf7fd37010ff2ad53b" ON "subscriptions" ("pagarmeSubscriptionId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "saved_cards" ("id" character varying NOT NULL, "userId" uuid NOT NULL, "lastFourDigits" character varying NOT NULL, "brand" character varying NOT NULL, "holderName" character varying NOT NULL, "expMonth" integer NOT NULL, "expYear" integer NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_00718d0da00daa3aec1e7881cbc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_e66cfc6746ba4ab45a9fb6458c" ON "saved_cards" ("userId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying NOT NULL, "description" character varying NOT NULL, "amount" numeric(10,2) NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "pagarmeOrderId" character varying, "mpPaymentId" character varying, "mpPreferenceId" character varying, "checkoutUrl" character varying, "pagarmeSubscriptionId" character varying, "pagarmeInvoiceId" character varying, "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "appUserId" uuid, "vendorUserId" uuid, CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_058e5febfa582f85aca260b95a" ON "payments" ("appUserId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_78e5920fb35c3aac7c36679f1b" ON "payments" ("vendorUserId") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "public"."pagarme_plans_vendorplan_enum" AS ENUM('FREE', 'PRO', 'PREMIUM', 'ENTERPRISE', 'CUSTOM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "pagarme_plans" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "pagarmePlanId" character varying NOT NULL, "vendorPlan" "public"."pagarme_plans_vendorplan_enum" NOT NULL, "billingPeriod" character varying NOT NULL, "intervalCount" integer NOT NULL, "priceInCents" integer NOT NULL, "installments" integer NOT NULL DEFAULT '1', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_1a1cea2fb630380ec9c5a286069" UNIQUE ("pagarmePlanId"), CONSTRAINT "PK_1e404652fb243980ed8361cf736" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_1a1cea2fb630380ec9c5a28606" ON "pagarme_plans" ("pagarmePlanId") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "public"."order_status_logs_fromstatus_enum" AS ENUM('AWAITING_PAYMENT', 'PAYMENT_REVIEW', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'VENDOR_CONFIRMED_PICKUP', 'PICKED_UP', 'DELIVERING', 'DELIVERER_CONFIRMED_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'DISPUTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "public"."order_status_logs_tostatus_enum" AS ENUM('AWAITING_PAYMENT', 'PAYMENT_REVIEW', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'VENDOR_CONFIRMED_PICKUP', 'PICKED_UP', 'DELIVERING', 'DELIVERER_CONFIRMED_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'DISPUTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "order_status_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "fromStatus" "public"."order_status_logs_fromstatus_enum" NOT NULL, "toStatus" "public"."order_status_logs_tostatus_enum" NOT NULL, "changedBy" character varying NOT NULL, "reason" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "orderId" uuid, CONSTRAINT "PK_8e29911f9edfb67c6810f56ac5a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_e6d7211687e7d0611124664e6d" ON "order_status_logs" ("orderId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "notification_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying NOT NULL, "to" character varying NOT NULL, "userName" character varying NOT NULL, "subject" character varying NOT NULL, "message" text NOT NULL, "success" boolean NOT NULL DEFAULT true, "error" character varying, "vendorId" character varying, "retryCount" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP, CONSTRAINT "PK_19c524e644cdeaebfcffc284871" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "platform_config" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "key" character varying NOT NULL, "value" character varying NOT NULL, "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_e288d39f7103fdc2a057f96b62e" UNIQUE ("key"), CONSTRAINT "PK_992be521a533da5953589a85fcf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "cart_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "quantity" integer NOT NULL DEFAULT '1', "notes" character varying, "weightGrams" integer, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "customerId" uuid, "productId" uuid, "storeId" uuid, CONSTRAINT "UQ_daf01d262fe1f0dd21285c2a66a" UNIQUE ("customerId", "productId"), CONSTRAINT "PK_6fccf5ec03c172d27a28a82928b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_e13650ee5441f2738a7ebeea82" ON "cart_items" ("customerId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_72679d98b31c737937b8932ebe" ON "cart_items" ("productId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_25c49e1f4630d8b791a120cdc3" ON "cart_items" ("storeId") `);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "categories" ADD CONSTRAINT "FK_fa6ba3528de12e174b163c09fdd" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "products" ADD CONSTRAINT "FK_782da5e50e94b763eb63225d69d" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "products" ADD CONSTRAINT "FK_ff56834e735fa78a15d0cf21926" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "services" ADD CONSTRAINT "FK_ee1c9f2a1a11b2ca0c9a24c2977" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "services" ADD CONSTRAINT "FK_034b52310c2d211bc979c3cc4e8" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "order_items" ADD CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "order_items" ADD CONSTRAINT "FK_cdb99c05982d5191ac8465ac010" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "deliveries" ADD CONSTRAINT "FK_5e2c4897f6f6fe0eddb9bdbada8" FOREIGN KEY ("delivererId") REFERENCES "app_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "deliveries" ADD CONSTRAINT "FK_f7433e3639e213f901e22cf8640" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "coupons" ADD CONSTRAINT "FK_1759bf86967840352d952797ed8" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "orders" ADD CONSTRAINT "FK_e5de51ca888d8b1f5ac25799dd1" FOREIGN KEY ("customerId") REFERENCES "app_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "orders" ADD CONSTRAINT "FK_0f82354e5b05fd87884eff3a7b5" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "orders" ADD CONSTRAINT "FK_c26db6c65929ecfeab91073e80c" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "addresses" ADD CONSTRAINT "FK_95c93a584de49f0b0e13f753630" FOREIGN KEY ("userId") REFERENCES "app_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "appointments" ADD CONSTRAINT "FK_60dbcf20669c096d319e20fca8a" FOREIGN KEY ("customerId") REFERENCES "app_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "appointments" ADD CONSTRAINT "FK_be987791dec56a5566fcfd4eb44" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "appointments" ADD CONSTRAINT "FK_f77953c373efb8ab146d98e90c3" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "stores" ADD CONSTRAINT "FK_a447ba082271c05997a61df26df" FOREIGN KEY ("ownerId") REFERENCES "vendor_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "store_follows" ADD CONSTRAINT "FK_f0efa141f718dec773bf42687f9" FOREIGN KEY ("userId") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "store_follows" ADD CONSTRAINT "FK_fa87e4569e2cd489d5cd57d9abc" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "schedules" ADD CONSTRAINT "FK_8ba0dbc7ec71486e5491bff6b12" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "service_ratings" ADD CONSTRAINT "FK_ade087917eb023bc4516a1db7d1" FOREIGN KEY ("customerId") REFERENCES "app_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "service_ratings" ADD CONSTRAINT "FK_ed55e888ef6797bbfc3bd6e3960" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "service_ratings" ADD CONSTRAINT "FK_58849e8c0ea7fd3f8892836c1d7" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "service_ratings" ADD CONSTRAINT "FK_f6b2587f79f584a1c163b6dccf4" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "promotions" ADD CONSTRAINT "FK_32bb72bb5f508d4aa02f215a589" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "promotions" ADD CONSTRAINT "FK_c8147b5d9ff0dfa7e37be56c1ba" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "subscriptions" ADD CONSTRAINT "FK_b5a470e3f438c1ebcb1bf15a784" FOREIGN KEY ("vendorUserId") REFERENCES "vendor_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "saved_cards" ADD CONSTRAINT "FK_e66cfc6746ba4ab45a9fb6458cc" FOREIGN KEY ("userId") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "payments" ADD CONSTRAINT "FK_058e5febfa582f85aca260b95a3" FOREIGN KEY ("appUserId") REFERENCES "app_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "payments" ADD CONSTRAINT "FK_78e5920fb35c3aac7c36679f1b3" FOREIGN KEY ("vendorUserId") REFERENCES "vendor_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "order_status_logs" ADD CONSTRAINT "FK_e6d7211687e7d0611124664e6de" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "cart_items" ADD CONSTRAINT "FK_e13650ee5441f2738a7ebeea82b" FOREIGN KEY ("customerId") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "cart_items" ADD CONSTRAINT "FK_72679d98b31c737937b8932ebe6" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN ALTER TABLE "cart_items" ADD CONSTRAINT "FK_25c49e1f4630d8b791a120cdc3b" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "cart_items" DROP CONSTRAINT IF EXISTS "FK_25c49e1f4630d8b791a120cdc3b"`);
        await queryRunner.query(`ALTER TABLE "cart_items" DROP CONSTRAINT IF EXISTS "FK_72679d98b31c737937b8932ebe6"`);
        await queryRunner.query(`ALTER TABLE "cart_items" DROP CONSTRAINT IF EXISTS "FK_e13650ee5441f2738a7ebeea82b"`);
        await queryRunner.query(`ALTER TABLE "order_status_logs" DROP CONSTRAINT IF EXISTS "FK_e6d7211687e7d0611124664e6de"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "FK_78e5920fb35c3aac7c36679f1b3"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "FK_058e5febfa582f85aca260b95a3"`);
        await queryRunner.query(`ALTER TABLE "saved_cards" DROP CONSTRAINT IF EXISTS "FK_e66cfc6746ba4ab45a9fb6458cc"`);
        await queryRunner.query(`ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "FK_b5a470e3f438c1ebcb1bf15a784"`);
        await queryRunner.query(`ALTER TABLE "promotions" DROP CONSTRAINT IF EXISTS "FK_c8147b5d9ff0dfa7e37be56c1ba"`);
        await queryRunner.query(`ALTER TABLE "promotions" DROP CONSTRAINT IF EXISTS "FK_32bb72bb5f508d4aa02f215a589"`);
        await queryRunner.query(`ALTER TABLE "service_ratings" DROP CONSTRAINT IF EXISTS "FK_f6b2587f79f584a1c163b6dccf4"`);
        await queryRunner.query(`ALTER TABLE "service_ratings" DROP CONSTRAINT IF EXISTS "FK_58849e8c0ea7fd3f8892836c1d7"`);
        await queryRunner.query(`ALTER TABLE "service_ratings" DROP CONSTRAINT IF EXISTS "FK_ed55e888ef6797bbfc3bd6e3960"`);
        await queryRunner.query(`ALTER TABLE "service_ratings" DROP CONSTRAINT IF EXISTS "FK_ade087917eb023bc4516a1db7d1"`);
        await queryRunner.query(`ALTER TABLE "schedules" DROP CONSTRAINT IF EXISTS "FK_8ba0dbc7ec71486e5491bff6b12"`);
        await queryRunner.query(`ALTER TABLE "store_follows" DROP CONSTRAINT IF EXISTS "FK_fa87e4569e2cd489d5cd57d9abc"`);
        await queryRunner.query(`ALTER TABLE "store_follows" DROP CONSTRAINT IF EXISTS "FK_f0efa141f718dec773bf42687f9"`);
        await queryRunner.query(`ALTER TABLE "stores" DROP CONSTRAINT IF EXISTS "FK_a447ba082271c05997a61df26df"`);
        await queryRunner.query(`ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "FK_f77953c373efb8ab146d98e90c3"`);
        await queryRunner.query(`ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "FK_be987791dec56a5566fcfd4eb44"`);
        await queryRunner.query(`ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "FK_60dbcf20669c096d319e20fca8a"`);
        await queryRunner.query(`ALTER TABLE "addresses" DROP CONSTRAINT IF EXISTS "FK_95c93a584de49f0b0e13f753630"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "FK_c26db6c65929ecfeab91073e80c"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "FK_0f82354e5b05fd87884eff3a7b5"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "FK_e5de51ca888d8b1f5ac25799dd1"`);
        await queryRunner.query(`ALTER TABLE "coupons" DROP CONSTRAINT IF EXISTS "FK_1759bf86967840352d952797ed8"`);
        await queryRunner.query(`ALTER TABLE "deliveries" DROP CONSTRAINT IF EXISTS "FK_f7433e3639e213f901e22cf8640"`);
        await queryRunner.query(`ALTER TABLE "deliveries" DROP CONSTRAINT IF EXISTS "FK_5e2c4897f6f6fe0eddb9bdbada8"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "FK_cdb99c05982d5191ac8465ac010"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "FK_f1d359a55923bb45b057fbdab0d"`);
        await queryRunner.query(`ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "FK_034b52310c2d211bc979c3cc4e8"`);
        await queryRunner.query(`ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "FK_ee1c9f2a1a11b2ca0c9a24c2977"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "FK_ff56834e735fa78a15d0cf21926"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "FK_782da5e50e94b763eb63225d69d"`);
        await queryRunner.query(`ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "FK_fa6ba3528de12e174b163c09fdd"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_25c49e1f4630d8b791a120cdc3"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_72679d98b31c737937b8932ebe"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_e13650ee5441f2738a7ebeea82"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "cart_items"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "platform_config"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "notification_logs"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_e6d7211687e7d0611124664e6d"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "order_status_logs"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."order_status_logs_tostatus_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."order_status_logs_fromstatus_enum"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_1a1cea2fb630380ec9c5a28606"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "pagarme_plans"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."pagarme_plans_vendorplan_enum"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_78e5920fb35c3aac7c36679f1b"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_058e5febfa582f85aca260b95a"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_e66cfc6746ba4ab45a9fb6458c"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "saved_cards"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_45307c12cf7fd37010ff2ad53b"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_b5a470e3f438c1ebcb1bf15a78"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "subscriptions"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."subscriptions_plan_enum"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_0effa251ae3fc10d598c08c8a8"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "webhook_events"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_c8147b5d9ff0dfa7e37be56c1b"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_32bb72bb5f508d4aa02f215a58"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "promotions"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_f6b2587f79f584a1c163b6dccf"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_58849e8c0ea7fd3f8892836c1d"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ed55e888ef6797bbfc3bd6e396"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ade087917eb023bc4516a1db7d"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "service_ratings"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_8ba0dbc7ec71486e5491bff6b1"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "schedules"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_fa87e4569e2cd489d5cd57d9ab"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_f0efa141f718dec773bf42687f"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "store_follows"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "approval_log"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."UQ_vendor_users_cpf"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "vendor_users"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."vendor_users_vendorplan_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."vendor_users_role_enum"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_a447ba082271c05997a61df26d"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "stores"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_f77953c373efb8ab146d98e90c"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_be987791dec56a5566fcfd4eb4"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_60dbcf20669c096d319e20fca8"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "appointments"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."appointments_status_enum"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."UQ_app_users_cpf"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "app_users"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."app_users_role_enum"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_95c93a584de49f0b0e13f75363"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "addresses"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_c26db6c65929ecfeab91073e80"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_0f82354e5b05fd87884eff3a7b"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_e5de51ca888d8b1f5ac25799dd"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_775c9f06fc27ae3ff8fb26f2c4"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "orders"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."orders_status_enum"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_1759bf86967840352d952797ed"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "coupons"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_5e2c4897f6f6fe0eddb9bdbada"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "deliveries"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cdb99c05982d5191ac8465ac01"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_f1d359a55923bb45b057fbdab0"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "order_items"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_034b52310c2d211bc979c3cc4e"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ee1c9f2a1a11b2ca0c9a24c297"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "services"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ff56834e735fa78a15d0cf2192"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_782da5e50e94b763eb63225d69"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "products"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_fa6ba3528de12e174b163c09fd"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "categories"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "site_config"`);
    }

}
