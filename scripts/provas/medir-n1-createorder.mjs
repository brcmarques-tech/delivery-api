// Mede quantos SELECT em products o createOrder dispara, com um carrinho de N
// itens. Serve para verificar o fix do N+1 (KAN-254): antes eram 2N queries
// (uma por item no laco, mais a rodada inteira outra vez na verificacao de
// idade); agora deve ser 1.
//
// Metodo: liga log_statement='all' no Postgres (recarregavel, sem restart),
// marca o instante no log, cria UM pedido, conta no log do container e desliga.
// Sem regex de proposito — o escape de backslash nao sobrevive ao shell aqui.
import { execSync } from 'node:child_process';
import { RECEBEDOR_VENDEDOR } from './recebedores-de-teste.mjs';

const URL = 'http://localhost:3000/graphql';
const ITENS = Number(process.argv[2] || 5);

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
  throw new Error('login ' + email + ': throttle persistente');
}
function cpf() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const d = (arr) => { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * (arr.length + 1 - i); const r = 11 - (s % 11); return r >= 10 ? 0 : r; };
  const d1 = d(n), d2 = d([...n, d1]);
  return [...n, d1, d2].join('');
}

const ts = Date.now();
console.log(`\n== preparando cenario (carrinho de ${ITENS} itens) ==`);

const vemail = `n1v_${ts}@t.com`;
await must(`mutation{ registerVendor(input:{name:"VendN1",email:"${vemail}",password:"teste123",phone:"5391${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerVendor');
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}' WHERE id='${vid}'`);
const V = await login(vemail, 'teste123', 'vendor');

const st = await must(`mutation{ createStore(input:{name:"Loja N1 ${ts}",phone:"5391000",street:"Rua A",number:"1",neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:true,latitude:-31.77,longitude:-52.34}){ id } }`, V.accessToken, 'createStore');
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"CatN1",storeId:"${storeId}"){ id } }`, V.accessToken, 'createCategory');

const produtos = [];
for (let i = 0; i < ITENS; i++) {
  const p = await must(`mutation{ createProduct(input:{name:"Prod N1 ${i}",price:25.00,stock:500,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`, V.accessToken, 'createProduct');
  produtos.push(p.createProduct.id);
}
console.log(`   loja + ${produtos.length} produtos criados`);

const cemail = `n1c_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"CliN1",email:"${cemail}",password:"teste123",phone:"5392${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp');
const C = await login(cemail);

// ---------------------------------------------------- medicao
console.log('\n== medindo ==');
sql(`ALTER SYSTEM SET log_statement='all'`);
sql(`SELECT pg_reload_conf()`);
await sleep(600);

const marca = `MARCA_N1_${ts}`;
sql(`SELECT '${marca}' AS marca`);

const itemsGql = produtos.map((id) => `{productId:"${id}",quantity:1}`).join(',');
const pedido = await must(
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[${itemsGql}],paymentMethod:"ON_DELIVERY",isPickup:true}){ id total } }`,
  C.accessToken,
  'createOrder',
);
await sleep(1500);

sql(`ALTER SYSTEM RESET log_statement`);
sql(`SELECT pg_reload_conf()`);

const log = execSync('docker logs shopping-postgres --tail 6000 2>&1', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const idx = log.lastIndexOf(marca);
if (idx < 0) {
  console.log('nao achei a marca no log — medicao inconclusiva');
  process.exit(1);
}
const linhas = log.slice(idx).split('\n');

// O Postgres loga prepared statement como "LOG:  execute <unnamed>: ..." e
// statement simples como "LOG:  statement: ...". O SQL do TypeORM quebra em
// varias linhas, entao juntamos as continuacoes (linha que nao comeca com data).
const blocos = [];
for (const l of linhas) {
  const ehInicio = l.includes('LOG:') && (l.includes('statement:') || l.includes('execute'));
  const ehData = l.startsWith('20');
  if (ehInicio) blocos.push(l);
  else if (blocos.length && !ehData) blocos[blocos.length - 1] += ' ' + l.trim();
}
// Conta so as queries cuja RAIZ e a entidade Product. Filtrar por "products"
// no texto pegava falso-positivo: as queries de Store e de Order citam a
// tabela nos joins e nao sao leitura de produto.
const ALVO = 'AS "Product_id"'.toUpperCase();
const selectsProdutos = blocos.filter((b) => b.toUpperCase().includes(ALVO));

console.log(`\npedido criado: ${pedido.createOrder.id} | total R$ ${pedido.createOrder.total}`);
console.log(`itens no carrinho:                      ${ITENS}`);
console.log(`SELECTs tocando products no createOrder: ${selectsProdutos.length}`);
console.log(`esperado ANTES do fix (4N em SQL):      ${4 * ITENS}`);
console.log(`esperado DEPOIS do fix:                 1`);
console.log(`\n(blocos de log analisados: ${blocos.length})`);
console.log('\n--- as queries contadas ---');
selectsProdutos.forEach((b, i) => {
  const pos = b.toUpperCase().indexOf('SELECT');
  console.log(`${i + 1}. ${b.slice(pos, pos + 190)}`);
});
