// Prova a flag APP_DELIVERY_REQUIRES_CARD no estado LIGADO (como vai ser em
// producao): PIX + entrega por entregador do app tem de ser RECUSADO, e
// retirada no PIX tem de continuar funcionando.
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
    if (msg.includes('throttl') || msg.includes('too many')) { await sleep(2000 * (i + 1)); continue; }
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

// vendedor com loja SEM frota propria (entrega por app)
const vemail = `flag_v_${ts}@t.com`;
await must(`mutation{ registerVendor(input:{name:"VFlag",email:"${vemail}",password:"teste123",phone:"5397${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerVendor');
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}' WHERE id='${vid}'`);
const V = await login(vemail, 'teste123', 'vendor');

const st = await must(`mutation{ createStore(input:{name:"Loja Flag ${ts}",phone:"5391000",street:"Rua A",number:"1",neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,latitude:-31.77,longitude:-52.34}){ id } }`, V.accessToken, 'createStore');
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"CatFlag",storeId:"${storeId}"){ id } }`, V.accessToken, 'createCategory');
const prod = await must(`mutation{ createProduct(input:{name:"Prod Flag",price:30.00,stock:50,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`, V.accessToken, 'createProduct');

const cemail = `flag_c_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"CFlag",email:"${cemail}",password:"teste123",phone:"5398${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp');
const C = await login(cemail);

console.log('\n=== flag LIGADA: PIX + entrega por entregador do app ===');
const pixEntrega = await gql(
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"Rua Cliente 50",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id } }`,
  C.accessToken,
);
check(!!pixEntrega.errors, 'PIX com entrega por app é RECUSADO', pixEntrega.errors?.[0]?.message);
check(
  /cart[ãa]o/i.test(pixEntrega.errors?.[0]?.message || ''),
  'a mensagem explica o que fazer (cartão, ou retirada)',
  pixEntrega.errors?.[0]?.message,
);

console.log('\n=== flag LIGADA: PIX com RETIRADA continua funcionando ===');
const pixRetirada = await gql(
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],paymentMethod:"PIX",isPickup:true}){ id status } }`,
  C.accessToken,
);
check(!pixRetirada.errors, 'PIX com retirada é ACEITO (não há entregador envolvido)', pixRetirada.errors?.[0]?.message);
if (!pixRetirada.errors) {
  const semCodigo = sql(`SELECT COALESCE("codigoVendedor",'-') FROM orders WHERE id='${pixRetirada.data.createOrder.id}'`);
  check(semCodigo === '-', 'e pedido de retirada NÃO recebe código (não há troca a fazer)', semCodigo);
}

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((f) => console.log(' - ' + f)); process.exit(1); }
