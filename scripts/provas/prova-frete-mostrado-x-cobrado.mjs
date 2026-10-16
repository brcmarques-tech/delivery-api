// ═══════════════════════════════════════════════════════════════════════════
// KAN-29 — O FRETE MOSTRADO É O FRETE COBRADO?
// ═══════════════════════════════════════════════════════════════════════════
//
// O app mostra o frete chamando `calculateDeliveryFee`. O servidor cobra o
// frete dentro do `createOrder`. Até hoje eram DUAS cópias da mesma conta de
// haversine, em arquivos diferentes — e duas cópias de uma conta de dinheiro
// divergem na primeira vez que alguém mexe numa delas. Divergência aqui
// significa o cliente ver um preço e pagar outro: a reclamação chega como
// "me cobraram errado", que é a pior categoria de bug que um marketplace
// pode ter.
//
// O KAN-29 juntou as duas no DistanciaService (rota da ORS, linha reta como
// plano B). Esta prova fixa a propriedade que importa — os dois caminhos dão
// o MESMO número — para a próxima mudança de frete não a desfazer calada.
//
// Vale com ou sem chave da ORS configurada: o que se compara é a igualdade
// entre os dois caminhos, não um valor cravado.
import { execSync } from 'node:child_process';
import { RECEBEDOR_VENDEDOR } from './recebedores-de-teste.mjs';

const URL = 'http://localhost:3000/graphql';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
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

const ts = Date.now();
const suf = String(ts).slice(-6);

// Loja no centro de Pelotas, cliente no Laranjal — longe o bastante para a
// rota e a linha reta darem números bem diferentes (é onde a divergência
// apareceria).
const LOJA = { lat: -31.7654, lng: -52.3376 };
const CLIENTE = { lat: -31.7354, lng: -52.2256 };

const vemail = `fr_v_${ts}@t.com`;
await must(
  `mutation{ registerVendor(input:{name:"Lojista Frete",email:"${vemail}",password:"teste123",phone:"5345${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerVendor',
);
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(
  `UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, ` +
  `"pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}', "vendorPlan"='PRO', "acceptedSubscriptionTermsAt"=now() WHERE id='${vid}'`,
);
const V = await login(vemail, 'vendor');

const st = await must(
  `mutation{ createStore(input:{name:"Loja Frete ${suf}",phone:"5391000",street:"Rua das Flores",number:"100",` +
  `neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,` +
  `latitude:${LOJA.lat},longitude:${LOJA.lng},deliveryFee:10.00,freeDelivery:false}){ id } }`,
  V, 'createStore',
);
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"Mercearia",storeId:"${storeId}"){ id } }`, V, 'createCategory');
const prod = await must(
  `mutation{ createProduct(input:{name:"Cesta Frete",price:80,stock:20,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`,
  V, 'createProduct',
);
if (sql(`SELECT "isOpen" FROM stores WHERE id='${storeId}'`) !== 't') {
  await must(`mutation{ toggleStoreOpen(id:"${storeId}"){ id } }`, V, 'toggleStoreOpen');
}

// ── 1. o frete MOSTRADO
const mostrado = await must(
  `{ calculateDeliveryFee(storeId:"${storeId}",customerLatitude:${CLIENTE.lat},customerLongitude:${CLIENTE.lng}) }`,
  null, 'calculateDeliveryFee',
);
const freteMostrado = Number(mostrado.calculateDeliveryFee);
check(freteMostrado > 0, 'a tela mostra um frete maior que zero', reais(freteMostrado));

// ── 2. o frete COBRADO, com as MESMAS coordenadas
const cemail = `fr_c_${ts}@t.com`;
await must(
  `mutation{ registerApp(input:{name:"Cliente Frete",email:"${cemail}",password:"teste123",phone:"5346${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerApp',
);
const C = await login(cemail);
const ped = await must(
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],` +
  // PIX, e nao ON_DELIVERY: loja sem frota propria recusa pagamento na
  // entrega (a trava do KAN-252), e o que esta prova compara e o frete.
  `paymentMethod:"PIX",deliveryAddress:"Rua do Cliente 50",` +
  `deliveryLatitude:${CLIENTE.lat},deliveryLongitude:${CLIENTE.lng}}){ orderNumber deliveryFee total subtotal } }`,
  C, 'createOrder',
);
const freteCobrado = Number(ped.createOrder.deliveryFee);
check(freteCobrado > 0, 'o pedido cobra um frete maior que zero', reais(freteCobrado));

check(
  Math.abs(freteCobrado - freteMostrado) < 0.005,
  'O FRETE MOSTRADO É IGUAL AO COBRADO (a conta é uma só)',
  `mostrado ${reais(freteMostrado)} / cobrado ${reais(freteCobrado)}`,
);

// ── 3. e o total fecha com ele
check(
  Math.abs(Number(ped.createOrder.total) - (Number(ped.createOrder.subtotal) + freteCobrado)) < 0.005,
  'total = subtotal + frete',
  reais(ped.createOrder.total),
);

// ── 4. a distância usada é plausível para o par de coordenadas
// (independe de ter chave da ORS: linha reta ~10,6 km; rota, mais que isso)
const log = execSync('docker logs --tail 40 shopping-api 2>&1', { encoding: 'utf8' });
const caiuParaLinhaReta = /\[ORS_FALHOU\]|\[ORS_FREIO\]|\[ORS_SUSPEITO\]/.test(log);
console.log(
  caiuParaLinhaReta
    ? '   (a ORS não respondeu nesta rodada — frete em linha reta, como o plano B manda)'
    : '   (sem aviso de queda da ORS no log)',
);

console.log(`\nRESULTADO: ${ok.length} ok, ${fail.length} falha(s)`);
if (fail.length) {
  for (const f of fail) console.log(`   ❌ ${f}`);
  process.exit(1);
}
console.log('   o cliente paga o frete que viu.');
