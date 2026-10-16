// A ÚLTIMA UNIDADE, DISPUTADA POR VÁRIOS CLIENTES AO MESMO TEMPO.
//
// É o caso clássico de marketplace, e o que ele produz quando falha é uma
// venda que a loja não tem como entregar: o cliente paga, o pedido entra, e
// alguém tem de ligar para desfazer.
//
// O decremento de estoque no `createOrder` é um claim atômico
// (`UPDATE ... WHERE stock >= $1 RETURNING stock`) e decide por
// `linhasAfetadas`. Em teoria está certo. Mas o claim do CUPOM também
// parecia certo e estava INERTE — decidia por `rows.length` num resultado de
// escrita, que tem comprimento 2 sempre, e respondia "reservei" mesmo com o
// cupom esgotado. Aquilo só apareceu em concorrência.
//
// Por isso este script não lê o código: dispara N pedidos simultâneos pela
// API, cada um de um cliente diferente, e conta.
//
// Testa dois cenários, porque falham por motivos diferentes:
//   A. N clientes, 1 unidade em estoque  -> exatamente 1 pode passar
//   B. N clientes, K unidades            -> exatamente K podem passar
import { execSync } from 'node:child_process';

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

const N = 6;
const ts = Date.now();
const suf = String(ts).slice(-6);

console.log('=== montando a loja e os clientes ===');

const vemail = `est_v_${ts}@t.com`;
await must(`mutation{ registerVendor(input:{name:"VEst",email:"${vemail}",password:"teste123",phone:"5321${suf}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerVendor');
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='re_est_v' WHERE id='${vid}'`);
const V = await login(vemail, 'vendor');

const st = await must(`mutation{ createStore(input:{name:"Loja Estoque ${suf}",phone:"5391000",street:"R",number:"1",neighborhood:"C",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:true,latitude:-31.77,longitude:-52.34}){ id } }`, V, 'createStore');
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"CatEst",storeId:"${storeId}"){ id } }`, V, 'createCategory');

// Os clientes são criados ANTES de qualquer disparo: criar conta dentro da
// janela de concorrência mediria o cadastro, não o estoque.
const tokens = [];
for (let i = 1; i <= N; i++) {
  const email = `est_c${i}_${ts}@t.com`;
  await must(`mutation{ registerApp(input:{name:"CliEst${i}",email:"${email}",password:"teste123",phone:"532${i}${suf}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp');
  tokens.push(await login(email));
}
console.log(`   ${N} clientes prontos\n`);

async function disputar(rotuloCenario, estoqueInicial, quantidadePorPedido) {
  const prod = await must(
    `mutation{ createProduct(input:{name:"Ultima ${rotuloCenario} ${suf}",price:25.00,stock:${estoqueInicial},` +
    `storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`,
    V, 'createProduct',
  );
  const produtoId = prod.createProduct.id;

  const consulta =
    `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${produtoId}",quantity:${quantidadePorPedido}}],` +
    `paymentMethod:"ON_DELIVERY",isPickup:true}){ id } }`;

  // Promise.all: os N saem juntos, sem ordem entre eles.
  const respostas = await Promise.all(tokens.map((t) => gql(consulta, t)));
  const aceitos = respostas.filter((r) => !r.errors).length;
  const recusados = respostas.filter((r) => r.errors);
  const estoqueFinal = Number(sql(`SELECT stock FROM products WHERE id='${produtoId}'`));
  const pedidos = Number(sql(
    `SELECT count(*) FROM order_items oi JOIN orders o ON o.id = oi."orderId" WHERE oi."productId"='${produtoId}'`,
  ));

  return { aceitos, recusados, estoqueFinal, pedidos, produtoId };
}

// ═══════════════════════════ A: todos querendo a ÚLTIMA unidade
console.log(`=== A. ${N} clientes, 1 unidade em estoque ===`);
const a = await disputar('A', 1, 1);
console.log(`   aceitos: ${a.aceitos} | estoque final: ${a.estoqueFinal} | pedidos com o produto: ${a.pedidos}`);
if (a.recusados.length) console.log(`   recusa tipica: "${a.recusados[0].errors[0].message.slice(0, 60)}"`);

check(a.aceitos === 1, 'exatamente UM cliente leva a última unidade', `${a.aceitos} de ${N}`);
check(a.estoqueFinal === 0, 'o estoque termina em ZERO, não negativo', String(a.estoqueFinal));
check(a.pedidos === 1, 'e existe exatamente UM pedido com o produto', String(a.pedidos));
// A recusa tem DUAS mensagens legítimas, e cada uma é certa no seu caso:
//
//   "não está disponível"   — o primeiro pedido zerou o estoque e marcou o
//                             produto indisponível; os seguintes batem nessa
//                             checagem ANTES de chegar ao claim atômico
//   "estoque insuficiente"  — o produto ainda está disponível, mas a
//                             quantidade pedida não cabe (cenário C)
//
// Eu esperava só a segunda e o teste acusou o produto por isso. O que importa
// verificar é que a pessoa entende o que houve: a mensagem nomeia o PRODUTO e
// diz o motivo, em vez de um "erro ao criar pedido".
check(
  a.recusados.every((r) => {
    const m = r.errors[0].message;
    return /n[ãa]o esta|não está|dispon[íi]vel|[Ee]stoque insuficiente/.test(m) && m.includes('Ultima A');
  }),
  'os recusados recebem mensagem específica, nomeando o produto',
  a.recusados[0]?.errors[0].message.slice(0, 55),
);


// ═══════════════════════════ B: K unidades para N clientes
const K = 3;
console.log(`\n=== B. ${N} clientes, ${K} unidades em estoque ===`);
const b = await disputar('B', K, 1);
console.log(`   aceitos: ${b.aceitos} | estoque final: ${b.estoqueFinal}`);
check(b.aceitos === K, `exatamente ${K} passam`, `${b.aceitos} de ${N}`);
check(b.estoqueFinal === 0, 'estoque zera sem ficar negativo', String(b.estoqueFinal));

// ═══════════════════════════ C: pedido de 2 unidades com 1 em estoque
console.log(`\n=== C. ${N} clientes pedindo 2 unidades, com apenas 1 em estoque ===`);
const c = await disputar('C', 1, 2);
console.log(`   aceitos: ${c.aceitos} | estoque final: ${c.estoqueFinal}`);
check(c.aceitos === 0, 'NINGUÉM passa — o pedido inteiro não cabe no estoque', String(c.aceitos));
check(c.estoqueFinal === 1, 'e a unidade continua disponível para quem pedir uma só', String(c.estoqueFinal));

// Aqui o produto ESTÁ disponível (estoque 1 > 0) e a quantidade é que não
// cabe. É o caso em que a mensagem de ESTOQUE é a certa, e é o que distingue
// este cenário do A — lá o produto já tinha ficado indisponível.
const mensagensC = c.recusados.map((r) => r.errors[0].message);
check(
  mensagensC.length > 0 && mensagensC.every((m) => /[Ee]stoque insuficiente/.test(m)),
  'com produto disponível e quantidade acima do estoque, a mensagem é de ESTOQUE',
  mensagensC[0]?.slice(0, 55),
);

// ═══════════════════════════ D: o produto some da vitrine ao zerar
console.log('\n=== D. ao zerar, o produto sai da prateleira ===');
check(
  sql(`SELECT "isAvailable" FROM products WHERE id='${a.produtoId}'`) === 'f',
  'produto com estoque zero fica indisponível (não é mais oferecido)',
);

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((f) => console.log('   ❌ ' + f)); process.exit(1); }
