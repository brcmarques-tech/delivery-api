// E2E DO PEDIDO SEM CÓDIGO: os botões antigos ainda funcionam, e o
// auto-confirm ainda paga.
//
// Dois motivos para este script existir, e os dois são sobre o DEPLOY:
//
// 1. PEDIDO EM TRÂNSITO NO MOMENTO DO DEPLOY. Os códigos só são gerados na
//    criação do pedido. Todo pedido que já estiver a caminho quando a feature
//    subir vai chegar na porta do cliente SEM código — e aí o único jeito de
//    concluí-lo são os botões antigos. Se a feature os tiver bloqueado para
//    todo mundo, esses pedidos ficam presos e ninguém recebe.
//
// 2. O BUG QUE ISTO PEGA. Em 15/10/2026 eu descobri que o scheduler de
//    auto-confirmação estava lançando em TODA rodada de 60s, e havia dias. A
//    linha era `.andWhere('order."codigoVendedor" IS NULL')` — alias cru com a
//    coluna entre aspas, e `order` é palavra reservada em SQL. O Postgres
//    respondia "syntax error at or near order" e o catch do scheduler engolia.
//
//    A intenção da linha era CERTA (pedido com código tem de ficar fora do
//    auto-confirm, porque era esse caminho que liberava repasse por decurso de
//    prazo sem ação nenhuma do cliente). O efeito foi o auto-confirm parar de
//    existir para TODOS. Nos pedidos sem código esse job é o que paga vendedor
//    e entregador quando o cliente nunca aperta "confirmar recebimento".
//
//    Passou por typecheck, 111 testes unitários e três E2E. Nenhum deles monta
//    aquele QueryBuilder contra o Postgres de verdade. Este monta.
//
// COMO SIMULA O PEDIDO LEGADO: cria o pedido normalmente e depois NULA as
// colunas de código no banco. Não é truque de teste — é exatamente o estado em
// que um pedido criado antes do deploy chega ao banco novo.
import { execSync } from 'node:child_process';

const URL = 'http://localhost:3000/graphql';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

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
async function must(query, token, rotulo) {
  const j = await gql(query, token);
  if (j.errors) throw new Error(`${rotulo}: ${j.errors[0].message}`);
  return j.data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(email, pw = 'teste123', kind = 'app') {
  const m = kind === 'vendor' ? 'loginVendor' : 'loginApp';
  for (let i = 0; i < 12; i++) {
    const j = await gql(`mutation{ ${m}(input:{email:"${email}",password:"${pw}"}, forceLogin:true){ accessToken user{ id role } } }`);
    if (!j.errors) return j.data[m];
    const msg = j.errors[0].message.toLowerCase();
    if (msg.includes('throttl') || msg.includes('too many')) { await sleep(2000 * (i + 1)); continue; }
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

const ts = Date.now();
console.log('=== montando o cenário ===');

const vemail = `leg_v_${ts}@t.com`;
await must(`mutation{ registerVendor(input:{name:"VendLeg",email:"${vemail}",password:"teste123",phone:"5371${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerVendor');
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='re_test_leg_v' WHERE id='${vid}'`);
const V = await login(vemail, 'teste123', 'vendor');

const st = await must(`mutation{ createStore(input:{name:"Loja Leg ${ts}",phone:"5391000",street:"Rua A",number:"1",neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,latitude:-31.77,longitude:-52.34}){ id } }`, V.accessToken, 'createStore');
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"CatLeg",storeId:"${storeId}"){ id } }`, V.accessToken, 'createCategory');
const prod = await must(`mutation{ createProduct(input:{name:"Prod Leg",price:35.00,stock:50,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`, V.accessToken, 'createProduct');

const cemail = `leg_c_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"CliLeg",email:"${cemail}",password:"teste123",phone:"5372${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp');
const C = await login(cemail);

const demail = `leg_d_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"EntLeg",email:"${demail}",password:"teste123",phone:"5373${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp (entregador)');
const did = sql(`SELECT id FROM app_users WHERE email='${demail}'`);
sql(`UPDATE app_users SET role='DELIVERER', "isDeliverer"=true, "mpConnected"=true, "pagarmeRecipientId"='re_test_leg_d' WHERE id='${did}'`);
const D = await login(demail);

const ped = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"Rua Cliente 50",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id orderNumber } }`, C.accessToken, 'createOrder');
const orderId = ped.createOrder.id;
console.log(`   pedido ${ped.createOrder.orderNumber}\n`);

// ═══════════════════════════════════ o pedido nasce COM código
console.log('=== o pedido nasce com código; eu o transformo em legado ===');
check(sql(`SELECT "codigoVendedor" IS NOT NULL FROM orders WHERE id='${orderId}'`) === 't',
  'recém-criado, o pedido TEM código');

const flagAntes = await gql(`{ order(id:"${orderId}"){ usaCodigoDeEntrega } }`, C.accessToken);
check(flagAntes.data?.order?.usaCodigoDeEntrega === true,
  'e o campo usaCodigoDeEntrega reflete isso (é o que o app usa para escolher o fluxo)',
  String(flagAntes.data?.order?.usaCodigoDeEntrega));

// Estado EXATO de um pedido criado antes do deploy.
sql(`UPDATE orders SET "codigoVendedor"=NULL, "codigoCliente"=NULL, "codigoEntregador"=NULL WHERE id='${orderId}'`);
const flagDepois = await gql(`{ order(id:"${orderId}"){ usaCodigoDeEntrega codigoDaLojaJaRegistrado } }`, C.accessToken);
check(flagDepois.data?.order?.usaCodigoDeEntrega === false,
  'sem códigos, usaCodigoDeEntrega é false — o app cai no fluxo antigo',
  String(flagDepois.data?.order?.usaCodigoDeEntrega));

// ═══════════════════════════════════ os botões antigos têm de funcionar
console.log('\n=== os BOTÕES antigos num pedido legado ===');
const sup = await login('superadmin@bcmtech.com');
await must(`mutation{ simulatePayment(orderId:"${orderId}"){ status } }`, sup.accessToken, 'simulatePayment');
for (const s of ['ACCEPTED', 'PREPARING', 'READY']) {
  await must(`mutation{ updateOrderStatus(id:"${orderId}",status:${s}){ status } }`, V.accessToken, s);
}
const aceite = await must(`mutation{ acceptDelivery(orderId:"${orderId}"){ id } }`, D.accessToken, 'acceptDelivery');
const deliveryId = aceite.acceptDelivery.id;

const coleta = await gql(`mutation{ confirmPickup(deliveryId:"${deliveryId}"){ id pickedUpAt } }`, D.accessToken);
check(!coleta.errors, 'confirmPickup (botão antigo) FUNCIONA em pedido sem código',
  coleta.errors?.[0]?.message?.slice(0, 80) || 'coletado');
check(sql(`SELECT status FROM orders WHERE id='${orderId}'`) === 'PICKED_UP',
  'a coleta deixa o pedido em PICKED_UP');

// ENTREGA RÁPIDA. Confirmar a entrega AGORA, segundos depois da coleta, é o
// caso que estava quebrado: a máquina de estados só aceita
// DELIVERING -> DELIVERER_CONFIRMED_DELIVERY, e quem movia PICKED_UP ->
// DELIVERING era um scheduler que exige 5 minutos de espera. Entrega de 3
// minutos é o normal em Pelotas, e era exatamente a que não fechava — o
// entregador recebia "Nao foi possivel confirmar a entrega."
//
// Não espero nada de propósito. Se voltar a quebrar, este teste falha aqui.
const entrega = await gql(`mutation{ confirmDelivery(deliveryId:"${deliveryId}"){ id deliveredAt } }`, D.accessToken);
check(!entrega.errors,
  'confirmDelivery funciona IMEDIATAMENTE após a coleta (entrega rápida, sem esperar os 5 min do scheduler)',
  entrega.errors?.[0]?.message?.slice(0, 90) || 'entregue na hora');

const st1 = sql(`SELECT status FROM orders WHERE id='${orderId}'`);
check(st1 === 'DELIVERER_CONFIRMED_DELIVERY', 'pedido em DELIVERER_CONFIRMED_DELIVERY, aguardando o cliente', st1);
check(sql(`SELECT "isSettled" FROM orders WHERE id='${orderId}'`) === 'f',
  'e o dinheiro ainda NÃO saiu (espera o cliente ou o auto-confirm)');

// ═══════════════════════════════════ o auto-confirm de 10 min
console.log('\n=== o AUTO-CONFIRM de 10 minutos ===');
console.log('   Este é o job que estava morto. Empurrando delivererConfirmedDeliveryAt');
console.log('   para 11 minutos atrás e esperando uma rodada do scheduler.');
sql(`UPDATE orders SET "delivererConfirmedDeliveryAt" = now() - interval '11 minutes' WHERE id='${orderId}'`);
await sleep(65_000);

const fim = sql(
  `SELECT status || '|' || "isSettled" || '|' || COALESCE("customerConfirmedAt"::text,'-') FROM orders WHERE id='${orderId}'`,
).split('|');
check(fim[0] === 'COMPLETED', 'o auto-confirm levou o pedido a COMPLETED', fim[0]);
check(fim[1] === 'true' || fim[1] === 't', 'e disparou o repasse', fim[1]);
check(fim[2] !== '-', 'gravando customerConfirmedAt (aqui é correto: é o decurso de prazo do fluxo antigo)', fim[2]);

// ═══════════════════════════════════ e o pedido COM código segue de fora
console.log('\n=== e o pedido COM código continua fora do auto-confirm ===');

// SEGUNDO ENTREGADOR, de propósito. Na primeira versão eu reusei o primeiro e o
// script morreu em "Voce ja tem uma entrega em andamento" — porque o pedido 1
// tinha ficado preso em PICKED_UP pelo bug da entrega rápida. O teste da
// segunda metade falhou por causa da primeira, e o erro não dizia isso. Com um
// entregador próprio, cada metade falha pelo seu próprio motivo.
const demail2 = `leg_d2_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"EntLeg2",email:"${demail2}",password:"teste123",phone:"5374${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp (entregador 2)');
const did2 = sql(`SELECT id FROM app_users WHERE email='${demail2}'`);
sql(`UPDATE app_users SET role='DELIVERER', "isDeliverer"=true, "mpConnected"=true, "pagarmeRecipientId"='re_test_leg_d2' WHERE id='${did2}'`);
const D2 = await login(demail2);

const ped2 = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"Rua Cliente 50",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id orderNumber } }`, C.accessToken, 'createOrder 2');
const orderId2 = ped2.createOrder.id;
await must(`mutation{ simulatePayment(orderId:"${orderId2}"){ status } }`, sup.accessToken, 'simulatePayment 2');
for (const s of ['ACCEPTED', 'PREPARING', 'READY']) {
  await must(`mutation{ updateOrderStatus(id:"${orderId2}",status:${s}){ status } }`, V.accessToken, s + ' 2');
}
await must(`mutation{ acceptDelivery(orderId:"${orderId2}"){ id } }`, D2.accessToken, 'acceptDelivery 2');
await sleep(300);
const codLoja2 = sql(`SELECT "codigoVendedor" FROM orders WHERE id='${orderId2}'`);
const codEnt2 = sql(`SELECT "codigoEntregador" FROM orders WHERE id='${orderId2}'`);
await must(`mutation{ registrarCodigoDaLoja(orderId:"${orderId2}",codigo:"${codLoja2}",latitude:-31.77,longitude:-52.34){ id } }`, D2.accessToken, 'cod. loja 2');
await must(`mutation{ registrarCodigoDoEntregador(orderId:"${orderId2}",codigo:"${codEnt2}"){ status } }`, V.accessToken, 'cod. entregador 2');
await must(`mutation{ registrarEntregaSemCodigo(orderId:"${orderId2}",motivo:"cliente nao desceu, deixei na portaria do predio"){ id } }`, D2.accessToken, 'sem codigo 2');
await sleep(400);

// Empurra o relógio do auto-confirm. Se o filtro de código não valesse, o
// auto-confirm pagaria agora — em 10 minutos, e não na janela de 24h de
// contestação. E pior: gravaria customerConfirmedAt, fabricando uma prova de
// recebimento que nunca houve.
sql(`UPDATE orders SET "delivererConfirmedDeliveryAt" = now() - interval '11 minutes' WHERE id='${orderId2}'`);
await sleep(65_000);
const fim2 = sql(
  `SELECT status || '|' || "isSettled" || '|' || COALESCE("customerConfirmedAt"::text,'-') FROM orders WHERE id='${orderId2}'`,
).split('|');
check(fim2[1] === 'false' || fim2[1] === 'f',
  'pedido COM código NÃO é liberado pelo auto-confirm de 10 min',
  `status=${fim2[0]} isSettled=${fim2[1]}`);
check(fim2[2] === '-',
  'e o auto-confirm NÃO fabricou prova de recebimento',
  fim2[2] === '-' ? 'customerConfirmedAt nulo' : `gravou ${fim2[2]}`);

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((f) => console.log('   ❌ ' + f)); process.exit(1); }
