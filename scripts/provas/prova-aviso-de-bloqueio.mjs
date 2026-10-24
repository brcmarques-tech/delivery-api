// AS 5 TENTATIVAS, UMA POR UMA: a pessoa é avisada antes de ser bloqueada?
//
// Achado em 15/10/2026, exercitando a tela do lojista no navegador. O servidor
// respondia apenas "Código incorreto." em toda tentativa errada, e na quinta
// bloqueava por 15 minutos — sem nenhum aviso pelo caminho.
//
// Quem paga por isso é o entregador na porta do cliente e o lojista com o
// entregador na frente dele: estavam na última chance e não sabiam.
//
// Não há o que esconder revelando as tentativas restantes. Quem tenta força
// bruta CONTA AS PRÓPRIAS tentativas — a informação já é dele. Quem não sabia
// era exatamente quem precisava saber. O que segue escondido é o que importa:
// qual código está errado, quantos dígitos batem, e qual é o certo.
//
// Este script dispara as 5 tentativas e imprime a mensagem de cada uma.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RECEBEDOR_VENDEDOR, RECEBEDOR_ENTREGADOR } from './recebedores-de-teste.mjs';

const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const URL = 'http://localhost:3000/graphql';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

const sql = (q) => execSync(
  `docker exec shopping-postgres psql -U shopping -d shopping_db -tAc "${q.replace(/"/g, '\\"')}"`,
  { encoding: 'utf8' },
).trim();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(email, kind = 'app') {
  const m = kind === 'vendor' ? 'loginVendor' : 'loginApp';
  for (let i = 0; i < 12; i++) {
    const j = await gql(`mutation{ ${m}(input:{email:"${email}",password:"teste123"}, forceLogin:true){ accessToken } }`);
    if (!j.errors) return j.data[m].accessToken;
    if (/throttl|too many/i.test(j.errors[0].message)) { await sleep(2000 * (i + 1)); continue; }
    throw new Error('login: ' + j.errors[0].message);
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
const vemail = `blq_v_${ts}@t.com`;
await must(`mutation{ registerVendor(input:{name:"VBlq",email:"${vemail}",password:"teste123",phone:"5341${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerVendor');
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}' WHERE id='${vid}'`);
const V = await login(vemail, 'vendor');

const st = await must(`mutation{ createStore(input:{name:"Loja Blq ${ts}",phone:"5391000",street:"Rua A",number:"1",neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,latitude:-31.77,longitude:-52.34}){ id } }`, V, 'createStore');
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"CatBlq",storeId:"${storeId}"){ id } }`, V, 'createCategory');
const prod = await must(`mutation{ createProduct(input:{name:"Prod Blq",price:20.00,stock:40,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`, V, 'createProduct');

const cemail = `blq_c_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"CBlq",email:"${cemail}",password:"teste123",phone:"5342${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp');
const C = await login(cemail);

const demail = `blq_d_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"DBlq",email:"${demail}",password:"teste123",phone:"5343${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp d');
const did = sql(`SELECT id FROM app_users WHERE email='${demail}'`);
sql(`UPDATE app_users SET role='DELIVERER', "isDeliverer"=true, "mpConnected"=true, "pagarmeRecipientId"='${RECEBEDOR_ENTREGADOR}' WHERE id='${did}'`);
const D = await login(demail);

const ped = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"Rua Cliente 1",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id orderNumber } }`, C, 'createOrder');
const orderId = ped.createOrder.id;

const sup = await login('superadmin@bcmtech.com');
await must(`mutation{ simulatePayment(orderId:"${orderId}"){ status } }`, sup, 'simulatePayment');
for (const s of ['ACCEPTED', 'PREPARING', 'READY']) {
  await must(`mutation{ updateOrderStatus(id:"${orderId}",status:${s}){ status } }`, V, s);
}
await must(`mutation{ acceptDelivery(orderId:"${orderId}"){ id } }`, D, 'acceptDelivery');
await sleep(400);

const codigoCerto = sql(`SELECT "codigoVendedor" FROM orders WHERE id='${orderId}'`);
console.log(`=== pedido ${ped.createOrder.orderNumber}, código da loja = ${codigoCerto} ===`);
console.log('=== 5 tentativas ERRADAS, uma por uma ===\n');

const mensagens = [];
for (let i = 1; i <= 5; i++) {
  // Um código errado que nunca colide com o certo.
  const errado = String((Number(codigoCerto) + i * 7 + 13) % 1000000).padStart(6, '0');
  const r = await gql(
    `mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"${errado}"){ id } }`,
    D,
  );
  const msg = r.errors?.[0]?.message || '(ACEITOU — não deveria)';
  mensagens.push(msg);
  console.log(`  tentativa ${i}: ${msg}`);
}

console.log('');
check(
  /Restam 4/.test(mensagens[0]),
  'a 1a tentativa já avisa quantas restam',
  mensagens[0],
);
check(
  /Restam 3/.test(mensagens[1]) && /Restam 2/.test(mensagens[2]),
  'a contagem desce a cada tentativa',
);
check(
  /Resta 1 tentativa/.test(mensagens[3]),
  'a 4a avisa que é a ÚLTIMA chance, no singular',
  mensagens[3],
);
check(
  /bloquead/i.test(mensagens[4]) && /15 minutos/.test(mensagens[4]),
  'a 5a diz que bloqueou e por quanto tempo',
  mensagens[4],
);
check(
  mensagens.every((m) => !m.includes(codigoCerto)),
  'NENHUMA mensagem revela o código certo',
);
check(
  mensagens.every((m) => !/d[íi]gito/i.test(m) || /confira o n[úu]mero/i.test(m)),
  'nenhuma mensagem diz quantos dígitos batem',
);

// E o bloqueio vale de verdade: nem o código CERTO passa agora.
const comCerto = await gql(
  `mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"${codigoCerto}"){ id } }`,
  D,
);
check(
  !!comCerto.errors && /Muitas tentativas/i.test(comCerto.errors[0].message),
  'durante o bloqueio, nem o código CERTO é aceito',
  comCerto.errors?.[0]?.message,
);
check(
  /\d+ minuto/.test(comCerto.errors?.[0]?.message || ''),
  'e a mensagem de bloqueio diz quantos minutos faltam',
  comCerto.errors?.[0]?.message,
);

// Passado o bloqueio, o código certo volta a funcionar — o bloqueio é
// temporário, e não a morte do pedido.
sql(`UPDATE orders SET "codigoBloqueadoAte" = now() - interval '1 minute' WHERE id='${orderId}'`);
const depois = await gql(
  `mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"${codigoCerto}"){ id } }`,
  D,
);
check(!depois.errors, 'vencido o bloqueio, o código certo é aceito', depois.errors?.[0]?.message);
check(
  sql(`SELECT "codigoVendedorUsadoEm" IS NOT NULL FROM orders WHERE id='${orderId}'`) === 't',
  'e a coleta fica registrada',
);

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((f) => console.log('   ❌ ' + f)); process.exit(1); }
