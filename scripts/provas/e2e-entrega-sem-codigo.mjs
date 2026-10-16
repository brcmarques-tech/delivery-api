// E2E DA ENTREGA SEM O CÓDIGO DO CLIENTE — o caminho que libera dinheiro SEM
// a confirmação do cliente.
//
// Por que existe: o E2E dos códigos (33 asserções) cobre o fluxo feliz e as
// formas de burlar, mas não cobre este desvio. E ele é o mais delicado dos
// dois, porque o pagamento sai sem o segredo que autoriza o pagamento. A
// legitimidade inteira da coisa depende de uma promessa escrita no comentário
// do código:
//
//   "abre uma janela de contestação para o cliente"
//   "depois de o cliente ter tido a janela inteira para contestar"
//
// Este script pergunta se essa promessa se cumpre. Duas perguntas, nessa ordem:
//
//   1. o cliente é AVISADO de que a entrega foi registrada sem o código dele?
//   2. se fosse avisado, ele CONSEGUIRIA contestar no estado em que o pedido
//      fica?
//
// E depois: a janela realmente libera quando vence, e o registro guarda a
// evidência (motivo, GPS, horário) que sustenta a decisão humana numa disputa.
import { execSync } from 'node:child_process';

const URL = 'http://localhost:3000/graphql';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

// Conta as linhas de log da API que mencionam um termo, nos ultimos N segundos.
// E o unico sinal LOCALMENTE OBSERVAVEL de que a notificacao foi tentada: push
// vai para o Expo (o cliente de teste nao tem token) e WhatsApp vai para o WAHA
// (que nao sobe na stack local). Os dois deixam rastro no log.
function logsDaApi(termo, segundos = 120) {
  try {
    const saida = execSync(`docker logs shopping-api --since ${segundos}s 2>&1`, { encoding: 'utf8' });
    return saida.split(/\r?\n/).filter((l) => l.includes(termo)).length;
  } catch {
    return 0;
  }
}

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
  for (let i = 0; i < 6; i++) {
    const j = await gql(`mutation{ ${m}(input:{email:"${email}",password:"${pw}"}, forceLogin:true){ accessToken user{ id role } } }`);
    if (!j.errors) return j.data[m];
    const msg = j.errors[0].message.toLowerCase();
    if (msg.includes('throttl') || msg.includes('too many')) { await sleep(1500 * (i + 1)); continue; }
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

// ═══════════════════════════════════ cenário
console.log('=== montando: loja sem frota própria, pedido PIX com entrega pelo app ===');

const vemail = `snc_v_${ts}@t.com`;
await must(`mutation{ registerVendor(input:{name:"VendSnc",email:"${vemail}",password:"teste123",phone:"5381${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerVendor');
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='re_test_snc_v' WHERE id='${vid}'`);
const V = await login(vemail, 'teste123', 'vendor');

const st = await must(`mutation{ createStore(input:{name:"Loja Snc ${ts}",phone:"5391000",street:"Rua A",number:"1",neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,latitude:-31.77,longitude:-52.34}){ id } }`, V.accessToken, 'createStore');
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"CatSnc",storeId:"${storeId}"){ id } }`, V.accessToken, 'createCategory');
const prod = await must(`mutation{ createProduct(input:{name:"Prod Snc",price:40.00,stock:50,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`, V.accessToken, 'createProduct');

const cemail = `snc_c_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"CliSnc",email:"${cemail}",password:"teste123",phone:"5382${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp');
const C = await login(cemail);
const cid = sql(`SELECT id FROM app_users WHERE email='${cemail}'`);

const demail = `snc_d_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"EntSnc",email:"${demail}",password:"teste123",phone:"5383${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp (entregador)');
const did = sql(`SELECT id FROM app_users WHERE email='${demail}'`);
sql(`UPDATE app_users SET role='DELIVERER', "isDeliverer"=true, "mpConnected"=true, "pagarmeRecipientId"='re_test_snc_d' WHERE id='${did}'`);
const D = await login(demail);

const ped = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"Rua Cliente 50",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id orderNumber } }`, C.accessToken, 'createOrder');
const orderId = ped.createOrder.id;
const num = ped.createOrder.orderNumber;
console.log(`   pedido ${num}\n`);

// ═══════════════════════════════════ até a coleta confirmada
const sup = await login('superadmin@bcmtech.com');
await must(`mutation{ simulatePayment(orderId:"${orderId}"){ status } }`, sup.accessToken, 'simulatePayment');
for (const s of ['ACCEPTED', 'PREPARING', 'READY']) {
  await must(`mutation{ updateOrderStatus(id:"${orderId}",status:${s}){ status } }`, V.accessToken, s);
}
await must(`mutation{ acceptDelivery(orderId:"${orderId}"){ id } }`, D.accessToken, 'acceptDelivery');
await sleep(400);

const codLoja = sql(`SELECT "codigoVendedor" FROM orders WHERE id='${orderId}'`);
const codEnt = sql(`SELECT "codigoEntregador" FROM orders WHERE id='${orderId}'`);
const codCli = sql(`SELECT "codigoCliente" FROM orders WHERE id='${orderId}'`);

// ═══════════════════════════════════ a guarda: sem coleta não há entrega
console.log('=== a guarda de ORDEM vale para o desvio também ===');
const antesDaColeta = await gql(
  `mutation{ registrarEntregaSemCodigo(orderId:"${orderId}",motivo:"cliente nao atendeu a campainha nem o telefone"){ id } }`,
  D.accessToken,
);
check(!!antesDaColeta.errors, 'não dá para alegar entrega sem ter coletado na loja',
  antesDaColeta.errors?.[0]?.message?.slice(0, 70));

// coleta pelos dois códigos
await must(`mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"${codLoja}",latitude:-31.77,longitude:-52.34){ id } }`, D.accessToken, 'cod. da loja');
await must(`mutation{ registrarCodigoDoEntregador(orderId:"${orderId}",codigo:"${codEnt}"){ status } }`, V.accessToken, 'cod. do entregador');
const statusColetado = sql(`SELECT status FROM orders WHERE id='${orderId}'`);
check(statusColetado === 'DELIVERING', 'coleta confirmada: pedido em DELIVERING', statusColetado);

// ═══════════════════════════════════ motivo curto não passa
console.log('\n=== o MOTIVO é o que a plataforma vai ler numa disputa ===');
const curto = await gql(`mutation{ registrarEntregaSemCodigo(orderId:"${orderId}",motivo:"nao abriu"){ id } }`, D.accessToken);
check(!!curto.errors, 'motivo com menos de 10 caracteres é recusado', curto.errors?.[0]?.message?.slice(0, 60));

// ═══════════════════════════════════ o registro
console.log('\n=== o REGISTRO sem código ===');
// O cliente precisa de telefone e token para os dois canais serem exercitados.
sql(`UPDATE app_users SET "expoPushToken"='ExponentPushToken[teste-snc-${ts}]' WHERE id='${cid}'`);
const zapAntes = logsDaApi('WhatsApp');

const MOTIVO = 'cliente nao atendeu a campainha nem o telefone, deixei com o porteiro';
await must(
  `mutation{ registrarEntregaSemCodigo(orderId:"${orderId}",motivo:"${MOTIVO}",latitude:-31.7612,longitude:-52.3345){ id status } }`,
  D.accessToken,
  'registrarEntregaSemCodigo',
);
await sleep(600);

const reg = sql(
  `SELECT COALESCE("entregaSemCodigoEm"::text,'-') || '|' || COALESCE("entregaSemCodigoMotivo",'-') || '|' ` +
  `|| COALESCE("codigoClienteLat"::text,'-') || '|' || COALESCE("codigoClienteLng"::text,'-') || '|' || status ` +
  `FROM orders WHERE id='${orderId}'`,
).split('|');
check(reg[0] !== '-', 'horário do registro gravado', reg[0]);
check(reg[1] === MOTIVO, 'motivo gravado integralmente');
check(reg[2] !== '-' && reg[3] !== '-', 'GPS do entregador gravado (evidência p/ disputa)', `${reg[2]},${reg[3]}`);
check(sql(`SELECT "isSettled" FROM orders WHERE id='${orderId}'`) === 'f',
  'o dinheiro NÃO saiu no registro (a janela ainda está aberta)');

const repetido = await gql(`mutation{ registrarEntregaSemCodigo(orderId:"${orderId}",motivo:"${MOTIVO}"){ id } }`, D.accessToken);
check(!!repetido.errors, 'registrar duas vezes é recusado (claim atômico)', repetido.errors?.[0]?.message?.slice(0, 60));

// ═══════════════════════════════════ PERGUNTA 1: o cliente foi avisado?
console.log('\n=== PERGUNTA 1: o cliente é avisado de que a janela abriu? ===');
// NOTA sobre a primeira versão desta verificação: ela contava linhas em
// `notification_logs`. Essa tabela é o log de E-MAIL (escrita pelo
// mail.service); push e WhatsApp não passam por ela. Então o teste acusava
// "nenhuma notificação" tanto antes quanto depois do conserto — media a coisa
// errada e teria me feito "consertar" um conserto que já funcionava.
//
// O conteúdo da mensagem (prazo, número do pedido, motivo) é verificado no
// teste unitário `src/orders/delivery-codes.service.spec.ts`, que é o nível
// certo para isso. Aqui só se pergunta se o canal foi acionado.
const zapDepois = logsDaApi('WhatsApp');
console.log(`   linhas de log do WhatsApp: antes=${zapAntes} depois=${zapDepois}`);
check(
  zapDepois > zapAntes,
  'o canal de notificação do CLIENTE foi acionado ao abrir a janela',
  zapDepois > zapAntes
    ? `${zapDepois - zapAntes} tentativa(s) registrada(s) no log da API`
    : 'NENHUMA tentativa — a janela corre em silêncio',
);

// ═══════════════════════════════════ PERGUNTA 2: ele consegue contestar?
console.log('\n=== PERGUNTA 2: no estado em que o pedido ficou, dá para contestar? ===');
console.log(`   status do pedido: ${reg[4]}`);
const contesta = await gql(
  `mutation{ customerDenyDelivery(orderId:"${orderId}",reason:"nao recebi nada, nao tem porteiro no meu predio"){ status } }`,
  C.accessToken,
);
const virouDisputa = !contesta.errors && contesta.data?.customerDenyDelivery?.status === 'DISPUTED';
check(
  virouDisputa,
  'o CLIENTE consegue contestar durante a janela',
  virouDisputa ? 'virou DISPUTED' : `RECUSADO: ${contesta.errors?.[0]?.message?.slice(0, 80)}`,
);

// ═══════════════════════════════════ ramo 1: contestado NAO libera
console.log('\n=== a JANELA vence num pedido CONTESTADO ===');
sql(`UPDATE orders SET "entregaSemCodigoEm" = now() - interval '48 hours' WHERE id='${orderId}'`);
console.log('   janela empurrada para 48h atrás; aguardando a rodada do scheduler...');
await sleep(65_000);
const disp = sql(`SELECT status || '|' || "isSettled" FROM orders WHERE id='${orderId}'`).split('|');
check(disp[1] === 'false' || disp[1] === 'f',
  'pedido CONTESTADO não é liberado pelo scheduler (a decisão é humana)',
  `status=${disp[0]} isSettled=${disp[1]}`);
check(disp[0] === 'DISPUTED', 'e ele permanece em DISPUTED', disp[0]);

// ═══════════════════════════════════ ramo 2: sem contestação, libera
//
// Precisa de um pedido NOVO: o primeiro ficou em disputa. Cobrir só um dos dois
// ramos foi exatamente o que aconteceu quando a contestação passou a funcionar —
// o ramo da liberação, que é o que paga o entregador, ficou sem teste.
console.log('\n=== segundo pedido: janela vence SEM contestação ===');
const ped2 = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"Rua Cliente 50",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id orderNumber } }`, C.accessToken, 'createOrder 2');
const orderId2 = ped2.createOrder.id;
await must(`mutation{ simulatePayment(orderId:"${orderId2}"){ status } }`, sup.accessToken, 'simulatePayment 2');
for (const s of ['ACCEPTED', 'PREPARING', 'READY']) {
  await must(`mutation{ updateOrderStatus(id:"${orderId2}",status:${s}){ status } }`, V.accessToken, s + ' 2');
}
await must(`mutation{ acceptDelivery(orderId:"${orderId2}"){ id } }`, D.accessToken, 'acceptDelivery 2');
await sleep(400);
const codLoja2 = sql(`SELECT "codigoVendedor" FROM orders WHERE id='${orderId2}'`);
const codEnt2 = sql(`SELECT "codigoEntregador" FROM orders WHERE id='${orderId2}'`);
await must(`mutation{ registrarCodigoDaLoja(orderId:"${orderId2}",codigo:"${codLoja2}",latitude:-31.77,longitude:-52.34){ id } }`, D.accessToken, 'cod. loja 2');
await must(`mutation{ registrarCodigoDoEntregador(orderId:"${orderId2}",codigo:"${codEnt2}"){ status } }`, V.accessToken, 'cod. entregador 2');
await must(
  `mutation{ registrarEntregaSemCodigo(orderId:"${orderId2}",motivo:"cliente pediu para deixar na portaria, nao desceu",latitude:-31.7613,longitude:-52.3346){ id status } }`,
  D.accessToken,
  'registrarEntregaSemCodigo 2',
);
await sleep(500);
check(sql(`SELECT status FROM orders WHERE id='${orderId2}'`) === 'DELIVERER_CONFIRMED_DELIVERY',
  'o registro leva o pedido a DELIVERER_CONFIRMED_DELIVERY');

sql(`UPDATE orders SET "entregaSemCodigoEm" = now() - interval '48 hours' WHERE id='${orderId2}'`);
console.log('   janela empurrada para 48h atrás; aguardando a rodada do scheduler...');
await sleep(65_000);
const fim = sql(
  `SELECT status || '|' || "isSettled" || '|' || COALESCE("customerConfirmedAt"::text,'-') FROM orders WHERE id='${orderId2}'`,
).split('|');
check(fim[0] === 'COMPLETED', 'a janela vencida SEM contestação leva o pedido a COMPLETED', fim[0]);
check(fim[1] === 'true' || fim[1] === 't', 'o repasse foi disparado pelo scheduler', fim[1]);
check(fim[2] === '-',
  'e NÃO há prova de recebimento do cliente (correto: ele não confirmou nada)',
  fim[2] === '-' ? 'customerConfirmedAt nulo' : `gravou ${fim[2]} indevidamente`);

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((f) => console.log('   ❌ ' + f)); process.exit(1); }
