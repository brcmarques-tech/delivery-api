// ═══════════════════════════════════════════════════════════════════════════
// KAN-252 — O CHECKOUT DO SITE OFERECE PIX E CARTÃO (e o dinheiro tem caminho)
// ═══════════════════════════════════════════════════════════════════════════
//
// O que esta prova existe para impedir:
//
//   1. O bug original: o checkout web mandava `paymentMethod: 'ON_DELIVERY'`
//      cravado. Para loja SEM frota própria (que é a única que o site atende,
//      em retirada), o backend recusa exatamente essa combinação quando não é
//      retirada — e o site não oferecia nenhum outro meio. A promessa do site
//      institucional ("PIX e cartão no checkout", "QR Code instantâneo")
//      existia e o produto não cumpria.
//
//   2. A regressão silenciosa: alguém mexe na seleção do CREATE_ORDER e o
//      QR do PIX deixa de vir. O pedido continua sendo criado, o cliente vê
//      "pedido criado" e NÃO TEM COMO PAGAR — o pedido morre em 30 min no
//      expirador. Nenhum teste de backend pega isso, porque o backend está
//      certo: é a seleção do GraphQL do site que ficou incompleta. Por isso
//      aqui também se lê o arquivo do site (parte 3).
//
//   3. A mentira de tela: pagamento online nasce em AWAITING_PAYMENT e a loja
//      só recebe quando o pagamento é confirmado. A tela de sucesso promete
//      "30 minutos para pagar" — se o expirador do servidor mudar de janela,
//      a promessa vira mentira. A parte 4 amarra o número da tela ao do
//      servidor.
//
// O QUE ESTA PROVA NÃO FAZ: não paga de verdade. Ela verifica que a cobrança
// foi CRIADA e que os dados de pagamento chegam ao cliente. A aritmética do
// split está provada ao centavo em src/payments/split-matriz.spec.ts, e o
// caminho inteiro em e2e-caminho-completo.mjs.
import { execSync } from 'node:child_process';
import fs, { readFileSync } from 'node:fs';

const URL = 'http://localhost:3000/graphql';
const SITE = 'D:/linux/Documents/bcmTech/shopping-storefront';
const API = 'D:/linux/Documents/bcmTech/shopping-api';

const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
const titulo = (t) => console.log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sql(q) {
  return execSync(
    `docker exec shopping-postgres psql -U shopping -d shopping_db -tAc "${q.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' },
  ).trim();
}
async function gql(query, token) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query }),
  });
  return r.json();
}
async function must(q, t, rotulo) {
  const j = await gql(q, t);
  if (j.errors) throw new Error(`${rotulo}: ${j.errors[0].message}`);
  return j.data;
}
// 12 tentativas: rodar os E2E em sequência estoura o throttle do login, e um
// teste que falha por throttle acusa o produto por culpa do teste.
async function login(email, kind = 'app') {
  const m = kind === 'vendor' ? 'loginVendor' : 'loginApp';
  for (let i = 0; i < 12; i++) {
    const j = await gql(`mutation{ ${m}(input:{email:"${email}",password:"teste123"}, forceLogin:true){ accessToken } }`);
    if (!j.errors) return j.data[m].accessToken;
    if (/throttl|too many/i.test(j.errors[0].message)) { await sleep(2000 * (i + 1)); continue; }
    throw new Error('login ' + email + ': ' + j.errors[0].message);
  }
  throw new Error('login: throttle');
}
function cpf() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const d = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * (a.length + 1 - i); const r = 11 - (s % 11); return r >= 10 ? 0 : r; };
  const d1 = d(n), d2 = d([...n, d1]);
  return [...n, d1, d2].join('');
}
const reais = (n) => `R$ ${Number(n).toFixed(2)}`;
// O Nest escreve LOG em stdout e ERROR em stderr, e o execSync só devolve
// stdout: ler o log sem o 2>&1 fazia a prova NÃO ENCONTRAR marcadores que
// estavam lá, e acusar o produto por um erro do teste.
const logDaApi = (linhas = 80) =>
  execSync(`docker logs --tail ${linhas} shopping-api 2>&1`, { encoding: 'utf8' });

const ts = Date.now();
const suf = String(ts).slice(-6);

// ════════════════════════════════════════════════ 1. CENÁRIO DO SITE
titulo('1. O CENÁRIO EXATO DO SITE — loja sem frota própria');

const vemail = `wp_v_${ts}@t.com`;
await must(
  `mutation{ registerVendor(input:{name:"Lojista Web",email:"${vemail}",password:"teste123",phone:"5341${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerVendor',
);
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
// O recebedor do vendedor tem que EXISTIR no Pagar.me: com um id fictício a
// cobrança PIX falha NO GATEWAY ("Recipient not found") e volta sem QR. Foi
// exatamente assim que o bug do 200-com-cobrança-falhada apareceu. Uso o
// recebedor REAL da plataforma (o único que existe no sandbox) e plano PREMIUM
// (comissão 0%), que deixa UMA regra de split apontando para ele.
const RECEBEDOR = (fs.readFileSync(`${API}/.env`, 'utf8')
  .match(/^PAGARME_PLATFORM_RECIPIENT_ID=(.*)$/m) || [])[1]?.trim();
if (!RECEBEDOR) throw new Error('PAGARME_PLATFORM_RECIPIENT_ID ausente no .env — sem ele não há como provar o PIX');
sql(
  `UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, ` +
  `"pagarmeRecipientId"='${RECEBEDOR}', "vendorPlan"='PREMIUM', "acceptedSubscriptionTermsAt"=now() WHERE id='${vid}'`,
);
const V = await login(vemail, 'vendor');

const st = await must(
  `mutation{ createStore(input:{name:"Loja Web ${suf}",phone:"5391000",street:"Rua das Flores",number:"100",` +
  `neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,` +
  `latitude:-31.7700,longitude:-52.3400,deliveryFee:10.00}){ id slug hasOwnDelivery } }`,
  V, 'createStore',
);
const storeId = st.createStore.id;
check(st.createStore.hasOwnDelivery === false,
  'loja usa entregadores da plataforma — é o caso em que o checkout fixo falhava');

const cat = await must(`mutation{ createCategory(name:"Mercearia",storeId:"${storeId}"){ id } }`, V, 'createCategory');
const PRECO = 50.0;
const prod = await must(
  `mutation{ createProduct(input:{name:"Cesta Web",price:${PRECO},stock:30,storeId:"${storeId}",` +
  `categoryId:"${cat.createCategory.id}"}){ id } }`,
  V, 'createProduct',
);
const produtoId = prod.createProduct.id;
if (sql(`SELECT "isOpen" FROM stores WHERE id='${storeId}'`) !== 't') {
  await must(`mutation{ toggleStoreOpen(id:"${storeId}"){ id } }`, V, 'toggleStoreOpen');
}
check(sql(`SELECT "isOpen" FROM stores WHERE id='${storeId}'`) === 't', 'loja aberta com produto no catálogo');

const cemail = `wp_c_${ts}@t.com`;
await must(
  `mutation{ registerApp(input:{name:"Cliente Web",email:"${cemail}",password:"teste123",phone:"5342${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerApp',
);
const C = await login(cemail);

const PEDIR = (metodo, retirada, extra = '') =>
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${produtoId}",quantity:1}],` +
  `paymentMethod:"${metodo}",isPickup:${retirada}${retirada ? '' : ',deliveryAddress:"Rua do Cliente 50"'}${extra}})` +
  `{ id orderNumber status subtotal deliveryFee total paymentMethod pixQrCode pixQrCodeBase64 checkoutUrl } }`;

// ════════════════════════════════════════════════ 2. OS TRÊS MEIOS
titulo('2. OS TRÊS MEIOS DE PAGAMENTO PELO SITE');

// 2a. O bug original, como anti-regressão: dinheiro na entrega, nesta loja,
// TEM que ser recusado. Se um dia isso passar, a trava que obriga o site a
// oferecer PIX/cartão caiu junto.
const naEntregaEntregue = await gql(PEDIR('ON_DELIVERY', false), C);
check(
  !!naEntregaEntregue.errors && /na entrega nao disponivel|Use PIX ou cartao/i.test(naEntregaEntregue.errors[0].message),
  'ON_DELIVERY + entrega por entregador do app: RECUSADO (o bug original)',
  naEntregaEntregue.errors?.[0]?.message?.slice(0, 60),
);

// 2b. Retirada paga na loja: continua funcionando (não removi a opção).
const naRetirada = await gql(PEDIR('ON_DELIVERY', true), C);
check(!naRetirada.errors, 'ON_DELIVERY + retirada: aceito',
  naRetirada.errors?.[0]?.message?.slice(0, 70) || naRetirada.data?.createOrder?.orderNumber);
if (!naRetirada.errors) {
  const o = naRetirada.data.createOrder;
  check(o.status === 'PENDING', 'pagamento na retirada entra direto na fila da loja', o.status);
  check(Number(o.deliveryFee) === 0, 'retirada não cobra frete', reais(o.deliveryFee));
}

// 2c. PIX — o que o cliente precisa para pagar tem que VOLTAR na resposta.
const pix = await gql(PEDIR('PIX', true), C);
check(!pix.errors, 'PIX: cobrança criada', pix.errors?.[0]?.message?.slice(0, 90));
if (!pix.errors) {
  const o = pix.data.createOrder;
  check(o.status === 'AWAITING_PAYMENT', 'PIX nasce AWAITING_PAYMENT (a loja ainda não recebeu)', o.status);
  check(o.paymentMethod === 'PIX', 'o pedido guarda o meio escolhido', o.paymentMethod);
  check(!!o.pixQrCode && o.pixQrCode.length > 20,
    'pixQrCode (copia e cola) veio preenchido — sem ele o cliente não paga',
    o.pixQrCode ? `${o.pixQrCode.slice(0, 18)}… (${o.pixQrCode.length} chars)` : 'VAZIO');
  check(!!o.pixQrCodeBase64, 'pixQrCodeBase64 (imagem do QR) veio preenchido',
    o.pixQrCodeBase64 ? String(o.pixQrCodeBase64).slice(0, 40) + '…' : 'VAZIO');
  check(Number(o.total) === PRECO && Number(o.deliveryFee) === 0,
    'total do PIX em retirada = subtotal, sem frete', reais(o.total));
}

// 2d. Cartão — o site NÃO tokeniza cartão: ele manda para a página do provedor.
// CARTÃO pelo site = página hospedada do provedor (/paymentlinks). MEDIDO em
// 2026-10-16: esse endpoint responde 401 de IP não liberado — o mesmo bloqueio
// de origem que trava /transfers (KAN-299/300). Então aqui há dois resultados
// legítimos, e a prova cobra o comportamento CERTO em cada um:
//   allowlist liberado -> checkoutUrl é URL de verdade
//   allowlist bloqueado -> erro que MANDA O CLIENTE PARA O PIX (e não um
//                          "tente novamente", que só repete o bloqueio)
const cartao = await gql(PEDIR('CREDIT_CARD', true), C);
if (!cartao.errors) {
  const o = cartao.data.createOrder;
  check(o.status === 'AWAITING_PAYMENT', 'CARTÃO: pedido nasce AWAITING_PAYMENT', o.status);
  check(!!o.checkoutUrl && /^https?:\/\//.test(o.checkoutUrl),
    'checkoutUrl é uma URL de verdade — é para onde a tela de sucesso manda o cliente',
    o.checkoutUrl ? String(o.checkoutUrl).slice(0, 48) + '…' : 'VAZIO');
} else {
  const msg = cartao.errors[0].message;
  check(/indispon[ií]vel/i.test(msg) && /PIX/i.test(msg),
    'CARTÃO bloqueado pelo allowlist: o cliente é mandado para o PIX, não para "tente novamente"',
    msg.slice(0, 90));
  const log = logDaApi();
  check(/\[LINK_BLOQUEADO\]/.test(log),
    'e o bloqueio fica rastreável no log como [LINK_BLOQUEADO] (é config, não código)');
}

// 2e. CPF: pagamento online exige CPF no cadastro, e o cliente precisa saber
// DISSO, não de um erro cru do gateway.
// O registerApp EXIGE cpf, então o cadastro sem CPF só existe como legado
// (quem se cadastrou antes da exigência). Reproduzo esse legado no banco.
const semCpfEmail = `wp_s_${ts}@t.com`;
await must(
  `mutation{ registerApp(input:{name:"Sem Cpf",email:"${semCpfEmail}",password:"teste123",phone:"5343${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerApp sem cpf',
);
sql(`UPDATE app_users SET cpf=NULL WHERE email='${semCpfEmail}'`);
const SC = await login(semCpfEmail);
const semCpf = await gql(PEDIR('PIX', true), SC);
check(
  !!semCpf.errors && /CPF/i.test(semCpf.errors[0].message),
  'PIX sem CPF no perfil: recusado com mensagem sobre CPF (a tela avisa antes)',
  semCpf.errors?.[0]?.message?.slice(0, 60),
);

// ════════════════════════════════════════════════ 2f. 200 COM COBRANÇA FALHADA
titulo('2f. O PIOR CASO: o gateway responde 200 com a cobrança FALHADA');

// MEDIDO no sandbox: split para recebedor inexistente devolve HTTP 200 com
// charges[0].status = 'failed' e NENHUM qr_code. Antes da guarda, createOrderPix
// logava sucesso e devolvia QR vazio: o cliente via "pedido criado" numa tela
// sem nada para pagar e o pedido morria no expirador 30 min depois.
sql(`UPDATE vendor_users SET "pagarmeRecipientId"='re_nao_existe_isso', "vendorPlan"='PRO' WHERE id='${vid}'`);
const pixQuebrado = await gql(PEDIR('PIX', true), C);
check(!!pixQuebrado.errors, 'cobrança falhada no gateway RECUSA o pedido (não finge sucesso)',
  pixQuebrado.errors?.[0]?.message?.slice(0, 80) || `criou ${pixQuebrado.data?.createOrder?.orderNumber} sem QR!`);
if (!pixQuebrado.errors) {
  const o = pixQuebrado.data.createOrder;
  check(false, `pedido ${o.orderNumber} ficou AWAITING_PAYMENT com QR "${o.pixQrCode || ''}"`);
}
const logPix = logDaApi(60);
check(/\[PIX_NAO_GERADO\]/.test(logPix),
  'e a falha aparece no log como [PIX_NAO_GERADO], com o motivo do gateway');
check(/Recipient not found/i.test(logPix),
  'com o motivo REAL do gateway, não uma mensagem genérica');
// devolve o recebedor válido para não deixar o cenário sujo
sql(`UPDATE vendor_users SET "pagarmeRecipientId"='${RECEBEDOR}', "vendorPlan"='PREMIUM' WHERE id='${vid}'`);

// ════════════════════════════════════════════════ 3. A FIAÇÃO DO SITE
titulo('3. A FIAÇÃO DO SITE — o backend certo não salva o site errado');

const gqlSite = readFileSync(`${SITE}/lib/graphql.ts`, 'utf8');
const createOrderSel = (gqlSite.match(/export const CREATE_ORDER[\s\S]*?`;/) || [''])[0];
for (const campo of ['paymentMethod', 'pixQrCode', 'pixQrCodeBase64', 'checkoutUrl']) {
  check(new RegExp(`^\\s*${campo}\\s*$`, 'm').test(createOrderSel),
    `CREATE_ORDER do site pede \`${campo}\``);
}

const fluxo = readFileSync(`${SITE}/components/CheckoutFlow.tsx`, 'utf8');
// Só vale CÓDIGO: o comentário que conta a história do bug cita
// `paymentMethod: 'ON_DELIVERY'` de propósito, e a primeira versão desta
// checagem acusava justamente a documentação do conserto.
const linhasDeCodigo = fluxo
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
check(!/paymentMethod:\s*'ON_DELIVERY'/.test(linhasDeCodigo),
  'o checkout NÃO manda mais ON_DELIVERY cravado');
check(/paymentMethod,\s*$/m.test(fluxo) || /paymentMethod,\r?$/m.test(fluxo),
  'manda o meio ESCOLHIDO pelo cliente');
for (const m of ['PIX', 'CREDIT_CARD', 'ON_DELIVERY']) {
  check(new RegExp(`valor: '${m}'`).test(fluxo), `o seletor oferece ${m}`);
}
check(/setPix\(\{/.test(fluxo) && /pix\?\.codigo/.test(fluxo),
  'a tela de sucesso guarda e MOSTRA o copia e cola do PIX');
check(/QRCodeSVG/.test(fluxo) && /value=\{pix\.codigo\}/.test(fluxo),
  'e desenha o QR LOCAL a partir do copia e cola (não depende de baixar imagem do provedor na hora de pagar)');
check(/pix\?\.imagem/.test(fluxo) && /<img/.test(fluxo),
  'com a imagem do provedor como plano B, se vier só ela');
check(/cartaoUrl/.test(fluxo) && /window\.open\(/.test(fluxo),
  'no cartão, leva o cliente para a página do provedor (e guarda o link se o pop-up for bloqueado)');
check(/navigator\.clipboard/.test(fluxo) && /execCommand\('copy'\)/.test(fluxo),
  'o botão de copiar tem plano B quando a clipboard API é negada');

// ════════════════════════════════════════════════ 4. A PROMESSA DOS 30 MIN
titulo('4. A PROMESSA DA TELA BATE COM O SERVIDOR?');

const svc = readFileSync(`${API}/src/orders/orders.service.ts`, 'utf8');
const janela = svc.match(/expireAwaitingPaymentOrders[\s\S]{0,400}?Date\.now\(\)\s*-\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
const minutosServidor = janela ? Number(janela[1]) : null;
const minutosTela = Number((fluxo.match(/Você tem (\d+) minutos para pagar/) || [])[1]);
check(minutosServidor === 30, 'o expirador do servidor usa 30 min', String(minutosServidor));
check(minutosTela === minutosServidor,
  'a tela promete exatamente a janela que o servidor aplica',
  `tela=${minutosTela} servidor=${minutosServidor}`);
check(/AWAITING_PAYMENT/.test(fluxo),
  'e o motivo está escrito no código da tela, para não virar número órfão');

// ════════════════════════════════════════════════ FIM
titulo(`RESULTADO: ${ok.length} ok, ${fail.length} falha(s)`);
if (fail.length) {
  for (const f of fail) console.log(`   ❌ ${f}`);
  process.exit(1);
}
console.log('   o site vende com PIX, cartão e pagamento presencial.');
