// PROVA do bug encontrado na auditoria de 2026-10-15:
//
// `coupons.incrementUsage` faz `UPDATE coupons ... RETURNING id` e decide por
// `rows.length > 0`. Com o driver do TypeORM, escrita com RETURNING devolve
// [linhas, contagem] — comprimento 2 SEMPRE. Entao o retorno e sempre `true`,
// mesmo quando o UPDATE nao afetou linha nenhuma por `usesCount >= maxUses`.
//
// Consequencia: um cupom de USO UNICO pode ser usado quantas vezes quiserem, e
// a mensagem "Este cupom atingiu o limite de usos" nunca aparece.
//
// Este arquivo e a MESMA classe de bug dos 23 claims corrigidos hoje — so que
// em coupons.service.ts, arquivo que ficou fora daquela varredura.
import { execSync } from 'node:child_process';
import { RECEBEDOR_VENDEDOR } from './recebedores-de-teste.mjs';

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
  for (let i = 0; i < 8; i++) {
    const j = await gql(`mutation{ ${m}(input:{email:"${email}",password:"${pw}"}, forceLogin:true){ accessToken user{ id role } } }`);
    if (!j.errors) return j.data[m];
    const msg = j.errors[0].message.toLowerCase();
    if (msg.includes('throttl') || msg.includes('too many')) { await sleep(2500 * (i + 1)); continue; }
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
console.log('=== cenario: cupom de USO UNICO (maxUses = 1) ===');

// Vendedor com loja de RETIRADA (evita a flag de cartao e nao precisa de entregador)
const vemail = `cup_v_${ts}@t.com`;
await must(`mutation{ registerVendor(input:{name:"VCup",email:"${vemail}",password:"teste123",phone:"5381${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerVendor');
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}', "vendorPlan"='PRO' WHERE id='${vid}'`);
const V = await login(vemail, 'teste123', 'vendor');

const st = await must(`mutation{ createStore(input:{name:"Loja Cup ${ts}",phone:"5391000",street:"Rua A",number:"1",neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:true,latitude:-31.77,longitude:-52.34}){ id } }`, V.accessToken, 'createStore');
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"CatCup",storeId:"${storeId}"){ id } }`, V.accessToken, 'createCategory');
const prod = await must(`mutation{ createProduct(input:{name:"Prod Cup",price:50.00,stock:500,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`, V.accessToken, 'createProduct');

// Cupom de uso UNICO, criado direto no banco para controlar maxUses com precisao
const codigo = `UNICO${String(ts).slice(-6)}`;
sql(`INSERT INTO coupons (code, "discountType", "discountValue", "maxUses", "usesCount", "isActive", "storeId") VALUES ('${codigo}', 'FIXED', 10, 1, 0, true, '${storeId}')`);
const cupomId = sql(`SELECT id FROM coupons WHERE code='${codigo}'`);
console.log(`   cupom ${codigo}: maxUses=1, usesCount=0\n`);

// Dois clientes diferentes (ha limite de 1 uso por cliente, que e outra regra)
const clientes = [];
for (const i of [1, 2]) {
  const email = `cup_c${i}_${ts}@t.com`;
  await must(`mutation{ registerApp(input:{name:"CliCup${i}",email:"${email}",password:"teste123",phone:"538${i}${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp');
  clientes.push(await login(email));
}

const pedir = (token) => gql(
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],paymentMethod:"ON_DELIVERY",isPickup:true,couponCode:"${codigo}"}){ id discount total } }`,
  token,
);

console.log('=== 1o uso do cupom (deve ser aceito) ===');
const r1 = await pedir(clientes[0].accessToken);
check(!r1.errors, 'primeiro cliente usa o cupom', r1.errors?.[0]?.message || `desconto R$ ${r1.data?.createOrder?.discount}`);
const uses1 = sql(`SELECT "usesCount" FROM coupons WHERE id='${cupomId}'`);
check(uses1 === '1', 'usesCount foi para 1', uses1);

console.log('\n=== 2o uso do MESMO cupom de uso unico (deve ser RECUSADO) ===');
const r2 = await pedir(clientes[1].accessToken);
const uses2 = sql(`SELECT "usesCount" FROM coupons WHERE id='${cupomId}'`);
if (r2.errors) {
  console.log(`   recusado: "${r2.errors[0].message}"`);
  check(true, 'o cupom de uso unico foi RECUSADO na segunda vez');
  check(uses2 === '1', 'usesCount continua 1 (nao estourou o limite)', uses2);
} else {
  console.log(`   ACEITO: pedido ${r2.data.createOrder.id} com desconto R$ ${r2.data.createOrder.discount}`);
  check(false, 'o cupom de uso unico foi RECUSADO na segunda vez',
    `ACEITOU — usesCount=${uses2}, maxUses=1. maxUses NAO esta sendo aplicado.`);
}

console.log(`\n   estado final do cupom: usesCount=${uses2} / maxUses=1`);
console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((f) => console.log(' - ' + f)); process.exit(1); }
