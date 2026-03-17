/**
 * TESTE VISUAL COMPLETO - FLUXO DE PAGAMENTO
 *
 * Simula o caminho real do usuário:
 * 1. Cliente cria pedido com PIX ou MERCADO_PAGO
 * 2. Cliente paga via sandbox do MP
 * 3. Webhook confirma pagamento
 * 4. Vendedor aceita e prepara
 * 5. Entregador aceita, coleta e entrega
 * 6. Cliente confirma recebimento
 * 7. Sistema mostra a separação de valores
 *
 * Uso: npx ts-node test/payment-flow-test.ts
 */

require('dotenv').config();
const API_URL = 'http://localhost:3000';
const SEPARATOR = '═'.repeat(60);
const LINE = '─'.repeat(60);

// Colors for terminal
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function header(text: string) {
  console.log(`\n${CYAN}${SEPARATOR}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${text}${RESET}`);
  console.log(`${CYAN}${SEPARATOR}${RESET}\n`);
}

function step(num: number, text: string) {
  console.log(`${BOLD}${GREEN}[PASSO ${num}]${RESET} ${text}`);
}

function info(label: string, value: any) {
  console.log(`  ${YELLOW}${label}:${RESET} ${value}`);
}

function money(label: string, value: number) {
  console.log(`  ${YELLOW}${label}:${RESET} R$ ${value.toFixed(2)}`);
}

function success(text: string) {
  console.log(`  ${GREEN}✓ ${text}${RESET}`);
}

function error(text: string) {
  console.log(`  ${RED}✗ ${text}${RESET}`);
}

async function gql(query: string, variables: any = {}, token?: string) {
  const headers: any = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`GraphQL Error: ${data.errors[0].message}`);
  }
  return data.data;
}

async function login(email: string, password: string, type: 'app' | 'vendor'): Promise<string> {
  const mutation = type === 'app'
    ? `mutation { loginApp(input: { email: "${email}", password: "${password}" }) { accessToken user { id name } } }`
    : `mutation { loginVendor(input: { email: "${email}", password: "${password}" }) { accessToken user { id name } } }`;

  const data = await gql(mutation);
  const result = type === 'app' ? data.loginApp : data.loginVendor;
  info(`${type === 'app' ? 'App' : 'Vendor'} User`, `${result.user.name} (${result.user.id.substring(0, 8)}...)`);
  return result.accessToken;
}

async function main() {
  try {
    header('TESTE DE FLUXO COMPLETO DE PAGAMENTO');
    console.log(`  Este teste simula o caminho real do usuario:`);
    console.log(`  Compra → Pagamento → Entrega → Confirmacao → Separacao de Valores\n`);

    // ─── LOGIN ─────────────────────────────────────────────────
    step(1, 'Logando usuarios...');
    const customerToken = await login('cliente@bcmtech.com', 'cliente123', 'app');
    const vendorToken = await login('admin@bcmtech.com', 'admin123', 'vendor');
    const delivererToken = await login('entregador@bcmtech.com', 'entrega123', 'app');
    success('Todos logados');

    // ─── BUSCAR OU CRIAR LOJA E PRODUTO ──────────────────────────
    step(2, 'Buscando ou criando loja e produto...');

    // Check for existing stores
    let storesData = await gql(`query { stores { id name deliveryFee isOpen } }`, {}, customerToken);
    let store = storesData.stores?.[0];

    if (!store) {
      info('Info', 'Nenhuma loja encontrada. Criando loja de teste...');
      const createStoreRes = await gql(`
        mutation {
          createStore(input: {
            name: "Loja Visual Test"
            description: "Loja para teste visual de pagamento"
            phone: "53999001122"
            street: "Rua Teste Visual"
            number: "123"
            neighborhood: "Centro"
            city: "Pelotas"
            state: "RS"
            zipCode: "96010-000"
            latitude: -31.7654
            longitude: -52.3456
            deliveryFee: 5.00
          }) { id name deliveryFee }
        }
      `, {}, vendorToken);
      store = createStoreRes.createStore;
      success(`Loja criada: ${store.name}`);
    }

    info('Loja', `${store.name} (${store.id.substring(0, 8)}...)`);
    money('Taxa de entrega', Number(store.deliveryFee));

    // Connect vendor MP account via direct GraphQL (get vendor ID and set MP credentials)
    step(2.1 as any, 'Conectando MP do vendedor...');
    const vendorMe = await gql(`query { meVendor { id mpConnected } }`, {}, vendorToken);
    const vendorUser = vendorMe.meVendor;
    // Always update vendor MP token to ensure it's the real test token
    const mpToken = process.env.MP_ACCESS_TOKEN!;
    const { Client } = require('pg');
    const pgClient = new Client({
      host: 'localhost',
      port: 5432,
      user: 'delivery',
      password: 'delivery123',
      database: 'delivery_db',
    });
    await pgClient.connect();
    await pgClient.query(
      `UPDATE vendor_users SET "mpConnected" = true, "mpAccessToken" = $1, "mpUserId" = '3255267120' WHERE id = $2`,
      [mpToken, vendorUser.id],
    );
    await pgClient.end();
    success(`Vendedor MP conectado (token: ${mpToken.substring(0, 20)}...)`);

    // Also connect deliverer's MP account
    const delivererMe = await gql(`query { meApp { id mpConnected } }`, {}, delivererToken);
    const delivererUser = delivererMe.meApp;
    if (!delivererUser.mpConnected) {
      const pgClient2 = new Client({
        host: 'localhost', port: 5432, user: 'delivery',
        password: 'delivery123', database: 'delivery_db',
      });
      await pgClient2.connect();
      await pgClient2.query(
        `UPDATE app_users SET "mpConnected" = true, "mpAccessToken" = $1, "mpUserId" = '888888' WHERE id = $2`,
        [mpToken, delivererUser.id],
      );
      await pgClient2.end();
      success('Entregador MP conectado via DB');
    }

    // Check for existing products or create one
    const storeData = await gql(`
      query { store(id: "${store.id}") {
        id name deliveryFee hasOwnDelivery
        products { id name price isAvailable stock }
        categories { id name }
      }}
    `, {}, customerToken);

    let products = storeData.store.products?.filter((p: any) => p.isAvailable && Number(p.stock) > 0) || [];
    let product: any;

    if (products.length === 0) {
      info('Info', 'Nenhum produto disponivel. Criando produto de teste...');
      const createProdRes = await gql(`
        mutation {
          createProduct(input: {
            storeId: "${store.id}"
            name: "X-Burger Visual Test"
            description: "Hamburguer para teste visual"
            price: 25.00
            stock: 100
          }) { id name price }
        }
      `, {}, vendorToken);
      product = createProdRes.createProduct;
      success(`Produto criado: ${product.name}`);
    } else {
      product = products[0];
    }

    info('Produto', `${product.name} - R$ ${Number(product.price).toFixed(2)}`);

    // ─── CALCULAR VALORES ESPERADOS ─────────────────────────────
    const QUANTIDADE = 2;
    const subtotal = Number(product.price) * QUANTIDADE;
    const deliveryFee = Number(store.deliveryFee) || 0;
    const total = subtotal + deliveryFee;

    console.log(`\n${LINE}`);
    console.log(`${BOLD}  VALORES DO PEDIDO (${QUANTIDADE}x ${product.name})${RESET}`);
    console.log(LINE);
    money('Subtotal', subtotal);
    money('Taxa de entrega', deliveryFee);
    money('Total', total);
    console.log(LINE);

    // ─── CRIAR PEDIDO ────────────────────────────────────────────
    const PAYMENT_METHOD = 'MERCADO_PAGO'; // Testar com Checkout Pro

    step(3, `Criando pedido com pagamento ${PAYMENT_METHOD}...`);
    const orderData = await gql(`
      mutation CreateOrder($input: CreateOrderInput!) {
        createOrder(input: $input) {
          id orderNumber status total subtotal deliveryFee
          commissionPercent commissionAmount
          paymentMethod checkoutUrl
        }
      }
    `, {
      input: {
        storeId: store.id,
        items: [{ productId: product.id, quantity: QUANTIDADE }],
        paymentMethod: PAYMENT_METHOD,
        deliveryAddress: 'Rua Teste Visual, 123 - Centro',
        deliveryLatitude: -31.7654,
        deliveryLongitude: -52.3456,
      },
    }, customerToken);

    const order = orderData.createOrder;
    info('Pedido', `#${order.orderNumber}`);
    info('Status', order.status);
    money('Subtotal', Number(order.subtotal));
    money('Taxa entrega', Number(order.deliveryFee));
    money('Total', Number(order.total));
    info('Comissao %', `${order.commissionPercent}%`);
    money('Comissao R$', Number(order.commissionAmount));

    // ─── CALCULAR SEPARAÇÃO DE VALORES ───────────────────────────
    const commissionAmount = Number(order.commissionAmount);
    const orderDeliveryFee = Number(order.deliveryFee);
    const orderSubtotal = Number(order.subtotal);
    const orderTotal = Number(order.total);

    // marketplace_fee = comissão + taxa de entrega (quando plataforma gerencia entrega)
    const marketplaceFee = commissionAmount + (storeData.store.hasOwnDelivery ? 0 : orderDeliveryFee);
    const vendorReceives = orderTotal - marketplaceFee;
    const platformKeeps = commissionAmount;
    const delivererReceives = storeData.store.hasOwnDelivery ? 0 : orderDeliveryFee;

    console.log(`\n${SEPARATOR}`);
    console.log(`${BOLD}${CYAN}  SEPARACAO DE VALORES ESPERADA${RESET}`);
    console.log(SEPARATOR);
    money('Total do pedido', orderTotal);
    console.log(LINE);
    money(`Vendedor recebe (subtotal - comissao)`, vendorReceives);
    money(`Plataforma retém (comissao ${order.commissionPercent}%)`, platformKeeps);
    money(`Entregador recebe (taxa de entrega)`, delivererReceives);
    console.log(LINE);
    money('marketplace_fee no MP', marketplaceFee);
    console.log(`  ${YELLOW}(comissao R$${commissionAmount.toFixed(2)} + entrega R$${orderDeliveryFee.toFixed(2)})${RESET}`);
    console.log(SEPARATOR);

    // ─── CHECKOUT URL & SIMULAR PAGAMENTO ──────────────────────────
    if (order.checkoutUrl) {
      step(4, 'Link de pagamento gerado!');
      console.log(`\n  ${BOLD}${GREEN}Checkout URL do sandbox:${RESET}`);
      console.log(`  ${CYAN}${order.checkoutUrl}${RESET}`);
      console.log(`\n  ${YELLOW}(Em producao, o cliente pagaria por este link)${RESET}`);

      // Simulate payment approval by transitioning order AWAITING_PAYMENT → PENDING
      console.log(`\n  ${BOLD}Simulando aprovacao de pagamento...${RESET}`);
      await gql(`mutation { updateOrderStatus(id: "${order.id}", status: PENDING) { id status } }`, {}, vendorToken);
      success('Pagamento simulado (AWAITING_PAYMENT → PENDING)');
    } else {
      step(4, 'Pedido criado sem necessidade de pagamento online');
    }

    // ─── VERIFICAR STATUS PÓS-PAGAMENTO ──────────────────────────
    step(5, 'Verificando pedido apos pagamento...');
    const orderAfterPayment = await gql(`
      query { order(id: "${order.id}") {
        id orderNumber status subtotal deliveryFee total
        commissionPercent commissionAmount paymentMethod
      }}
    `, {}, customerToken);
    info('Status', orderAfterPayment.order.status);

    // ─── VENDEDOR ACEITA E PREPARA ───────────────────────────────
    step(6, 'Vendedor aceita e prepara o pedido...');
    await gql(`mutation { updateOrderStatus(id: "${order.id}", status: ACCEPTED) { id status } }`, {}, vendorToken);
    success('Pedido aceito');

    await gql(`mutation { updateOrderStatus(id: "${order.id}", status: PREPARING) { id status } }`, {}, vendorToken);
    success('Pedido em preparo');

    await gql(`mutation { updateOrderStatus(id: "${order.id}", status: READY) { id status } }`, {}, vendorToken);
    success('Pedido pronto para entrega');

    // ─── ENTREGADOR ACEITA ────────────────────────────────────────
    step(7, 'Entregador aceita a entrega...');
    const deliveryData = await gql(`
      mutation { acceptDelivery(orderId: "${order.id}") { id } }
    `, {}, delivererToken);
    const deliveryId = deliveryData.acceptDelivery.id;
    success(`Entrega aceita (ID: ${deliveryId.substring(0, 8)}...)`);

    // ─── ENTREGADOR CONFIRMA COLETA ───────────────────────────────
    step(8, 'Entregador confirma coleta na loja...');
    await gql(`mutation { confirmPickup(deliveryId: "${deliveryId}") { id pickedUpAt } }`, {}, delivererToken);
    success('Coleta confirmada');

    // ─── ENTREGADOR CONFIRMA ENTREGA ──────────────────────────────
    step(9, 'Entregador confirma entrega ao cliente...');
    const deliveryResult = await gql(`
      mutation { confirmDelivery(deliveryId: "${deliveryId}") {
        id deliveredAt
        payoutStatus payoutAmount
        vendorPayoutStatus vendorPayoutAmount
      }}
    `, {}, delivererToken);

    const del = deliveryResult.confirmDelivery;
    success('Entrega confirmada');

    console.log(`\n${SEPARATOR}`);
    console.log(`${BOLD}${CYAN}  STATUS DOS PAGAMENTOS APOS ENTREGA${RESET}`);
    console.log(SEPARATOR);

    console.log(`\n  ${BOLD}Vendedor:${RESET}`);
    info('    Status', del.vendorPayoutStatus);
    money('    Valor', Number(del.vendorPayoutAmount || 0));
    if (del.vendorPayoutStatus === 'split_auto') {
      success('    Vendedor recebe automaticamente via marketplace_fee do MP');
    }

    console.log(`\n  ${BOLD}Entregador:${RESET}`);
    info('    Status', del.payoutStatus);
    money('    Valor', Number(del.payoutAmount || 0));
    if (del.payoutStatus === 'pending_confirmation') {
      info('    Aguardando', 'Confirmacao do cliente para liberar pagamento');
    }

    console.log(`\n  ${BOLD}Plataforma:${RESET}`);
    money('    Comissao retida', commissionAmount);
    if (!storeData.store.hasOwnDelivery) {
      money('    Taxa entrega (em custódia)', orderDeliveryFee);
    }

    // ─── CLIENTE CONFIRMA RECEBIMENTO ─────────────────────────────
    step(10, 'Cliente confirma recebimento do pedido...');
    const confirmResult = await gql(`
      mutation { confirmReceipt(orderId: "${order.id}") {
        id status customerConfirmedAt
        delivery { payoutStatus payoutAmount vendorPayoutStatus vendorPayoutAmount }
      }}
    `, {}, customerToken);

    success('Recebimento confirmado pelo cliente');

    const finalDelivery = confirmResult.confirmReceipt.delivery;

    // ─── RESULTADO FINAL ──────────────────────────────────────────
    header('RESULTADO FINAL - SEPARACAO DE VALORES');

    console.log(`  ${BOLD}Pedido #${order.orderNumber}${RESET}`);
    console.log(`  Pagamento: ${PAYMENT_METHOD}`);
    console.log(`  Status: ${confirmResult.confirmReceipt.status}`);
    console.log(`  Confirmado pelo cliente: ${confirmResult.confirmReceipt.customerConfirmedAt ? 'Sim' : 'Nao'}\n`);

    console.log(LINE);
    console.log(`  ${BOLD}VALOR TOTAL DO PEDIDO${RESET}`);
    console.log(LINE);
    money('  Subtotal (produtos)', orderSubtotal);
    money('  Taxa de entrega', orderDeliveryFee);
    money('  TOTAL COBRADO', orderTotal);

    console.log(`\n${LINE}`);
    console.log(`  ${BOLD}DISTRIBUICAO DO DINHEIRO${RESET}`);
    console.log(LINE);

    // Vendedor
    const vendorFinal = Number(finalDelivery?.vendorPayoutAmount || del.vendorPayoutAmount || 0);
    const vendorStatus = finalDelivery?.vendorPayoutStatus || del.vendorPayoutStatus;
    console.log(`\n  ${GREEN}${BOLD}VENDEDOR${RESET}`);
    money('  Valor recebido', vendorFinal);
    info('  Status', vendorStatus);
    info('  Como recebe', vendorStatus === 'split_auto'
      ? 'Automatico via marketplace_fee (MP deposita direto)'
      : 'Transfer manual');

    // Entregador
    const delivererFinal = Number(finalDelivery?.payoutAmount || del.payoutAmount || 0);
    const delivererStatus = finalDelivery?.payoutStatus || del.payoutStatus;
    console.log(`\n  ${GREEN}${BOLD}ENTREGADOR${RESET}`);
    money('  Valor a receber', delivererFinal);
    info('  Status', delivererStatus);
    info('  Como recebe', 'Transfer da plataforma apos confirmacao do cliente');

    // Plataforma
    console.log(`\n  ${GREEN}${BOLD}PLATAFORMA (BCM TECH)${RESET}`);
    money('  Comissao', commissionAmount);
    info('  Percentual', `${order.commissionPercent}% sobre subtotal`);
    info('  Como recebe', 'Retido via marketplace_fee no checkout');

    // Verificação
    console.log(`\n${LINE}`);
    console.log(`  ${BOLD}VERIFICACAO MATEMATICA${RESET}`);
    console.log(LINE);
    const totalDistribuido = vendorFinal + delivererFinal + commissionAmount;
    money('  Vendedor', vendorFinal);
    money('  + Entregador', delivererFinal);
    money('  + Plataforma', commissionAmount);
    console.log(`  ${LINE}`);
    money('  = Total distribuido', totalDistribuido);
    money('  = Total cobrado', orderTotal);

    if (Math.abs(totalDistribuido - orderTotal) < 0.01) {
      console.log(`\n  ${GREEN}${BOLD}✓ VALORES BATEM! Distribuicao correta.${RESET}`);
    } else {
      console.log(`\n  ${RED}${BOLD}✗ DIFERENÇA de R$ ${Math.abs(totalDistribuido - orderTotal).toFixed(2)}${RESET}`);
    }

    // Resumo visual
    console.log(`\n${SEPARATOR}`);
    console.log(`${BOLD}${CYAN}  FLUXO DO DINHEIRO${RESET}`);
    console.log(SEPARATOR);
    console.log(`
  Cliente paga: R$ ${orderTotal.toFixed(2)}
       │
       ▼
  ┌─────────────────────────────────┐
  │     MERCADO PAGO (Checkout)     │
  │   marketplace_fee: R$ ${marketplaceFee.toFixed(2)}      │
  └──────────┬──────────────────────┘
             │
     ┌───────┴───────┐
     ▼               ▼
  ┌──────────┐  ┌──────────────┐
  │ VENDEDOR │  │  PLATAFORMA  │
  │R$ ${vendorFinal.toFixed(2).padStart(6)}  │  │ R$ ${marketplaceFee.toFixed(2).padStart(6)}     │
  │(${vendorStatus})│  │              │
  └──────────┘  └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │ ENTREGADOR   │
                │ R$ ${delivererFinal.toFixed(2).padStart(6)}     │
                │ (${delivererStatus})│
                └──────────────┘

  Plataforma fica com: R$ ${commissionAmount.toFixed(2)} (comissao)
`);

    console.log(`${GREEN}${BOLD}TESTE CONCLUIDO COM SUCESSO!${RESET}\n`);

  } catch (err: any) {
    error(`Erro: ${err.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
