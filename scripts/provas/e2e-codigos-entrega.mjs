// E2E da garantia de entrega por CÓDIGOS, contra a API local.
//
// Exercita o fluxo inteiro e, principalmente, as formas de BURLAR:
//   - o entregador consegue ler o código do cliente? (não pode)
//   - o tipo Order carrega algum código de carona? (não pode)
//   - dá para registrar o código do cliente sem passar na loja? (não pode)
//   - dá para avançar pelos botões antigos e pular os códigos? (não pode)
//   - força bruta no código do cliente? (bloqueia)
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
console.log('=== cenário: loja com entrega pelo app ===');

// vendedor aprovado + loja SEM frota própria (para precisar de entregador)
const vemail = `cod_v_${ts}@t.com`;
await must(`mutation{ registerVendor(input:{name:"VendCod",email:"${vemail}",password:"teste123",phone:"5394${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerVendor');
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='re_test_cod_v' WHERE id='${vid}'`);
const V = await login(vemail, 'teste123', 'vendor');

const st = await must(`mutation{ createStore(input:{name:"Loja Cod ${ts}",phone:"5391000",street:"Rua A",number:"1",neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,latitude:-31.77,longitude:-52.34}){ id } }`, V.accessToken, 'createStore');
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"CatCod",storeId:"${storeId}"){ id } }`, V.accessToken, 'createCategory');
const prod = await must(`mutation{ createProduct(input:{name:"Prod Cod",price:30.00,stock:50,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`, V.accessToken, 'createProduct');

// cliente
const cemail = `cod_c_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"CliCod",email:"${cemail}",password:"teste123",phone:"5395${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp');
const C = await login(cemail);

// entregador aprovado
const demail = `cod_d_${ts}@t.com`;
await must(`mutation{ registerApp(input:{name:"EntCod",email:"${demail}",password:"teste123",phone:"5396${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`, null, 'registerApp (entregador)');
const did = sql(`SELECT id FROM app_users WHERE email='${demail}'`);
sql(`UPDATE app_users SET role='DELIVERER', "isDeliverer"=true, "mpConnected"=true, "pagarmeRecipientId"='re_test_cod_d' WHERE id='${did}'`);
const D = await login(demail);
console.log(`   vendedor, cliente e entregador criados\n`);

// pedido PIX com entrega pelo app
const ped = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${prod.createProduct.id}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"Rua Cliente 50",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id orderNumber status } }`, C.accessToken, 'createOrder');
const orderId = ped.createOrder.id;
console.log(`=== pedido ${ped.createOrder.orderNumber} criado (${ped.createOrder.status}) ===`);

// ─────────────────────────────────────────── geração
const codsNoBanco = sql(`SELECT COALESCE("codigoVendedor",'-') || '|' || COALESCE("codigoCliente",'-') || '|' || COALESCE("codigoEntregador",'-') FROM orders WHERE id='${orderId}'`).split('|');
check(/^\d{6}$/.test(codsNoBanco[0]), 'código do LOJISTA gerado na criação (6 dígitos)', codsNoBanco[0]);
check(/^\d{6}$/.test(codsNoBanco[1]), 'código do CLIENTE gerado na criação (6 dígitos)', codsNoBanco[1]);
check(codsNoBanco[2] === '-', 'código do ENTREGADOR ainda NÃO existe (não há entregador)', codsNoBanco[2]);
check(codsNoBanco[0] !== codsNoBanco[1], 'os códigos são distintos entre si');

// ─────────────────────────────────────────── vazamento
console.log('\n=== tentativas de VAZAMENTO ===');
// Esta verificação mudou quando a UI dos códigos precisou saber SE o pedido usa
// códigos. Antes ela proibia qualquer campo com "codigo" no nome, e acusou os
// dois booleanos de metadado (`usaCodigoDeEntrega`, `codigoDaLojaJaRegistrado`)
// — fazendo o trabalho dela, porque eu de fato mexi no tipo Order.
//
// A forma nova é MAIS forte, não mais frouxa: em vez de proibir o nome, exige o
// TIPO. Todo campo com "codigo" no nome tem de ser Boolean. Num booleano não
// cabe um código de 6 dígitos; numa String cabe. A regra passa a ser sobre o que
// pode carregar o segredo, e não sobre como alguém batizou o campo — e segue
// reprovando se alguém expuser `codigoCliente: String`.
const tipoOrder = await gql(`{ __type(name:"Order"){ fields { name type { kind name ofType { name } } } } }`);
const camposComCodigo = (tipoOrder.data.__type.fields || []).filter((f) => /codigo/i.test(f.name));
const nomeDoTipo = (t) => t?.name || t?.ofType?.name || t?.kind;
const naoBooleanos = camposComCodigo.filter((f) => nomeDoTipo(f.type) !== 'Boolean');
check(
  naoBooleanos.length === 0,
  'todo campo com "codigo" no nome no tipo Order e BOOLEANO (nao cabe um codigo)',
  naoBooleanos.length === 0
    ? (camposComCodigo.map((f) => f.name).join(', ') || 'nenhum campo')
    : 'VAZA: ' + naoBooleanos.map((f) => `${f.name}: ${nomeDoTipo(f.type)}`).join(', '),
);

// Assertiva pelos VALORES reais dos códigos, e não por padrão de dígitos: o
// id do pedido é um UUID e pode ter 6 dígitos seguidos por coincidência — foi
// isso que fez esta verificação dar falso negativo na primeira rodada.
// Antes de aceitar a corrida o entregador nem enxerga o pedido — autorização
// correta, e vazamento nenhum é possível aqui. A checagem que importa é
// DEPOIS do aceite, quando ele passa a ter acesso legítimo ao pedido: é lá
// que um código poderia vir de carona. (Na primeira rodada eu checei antes do
// aceite e o teste acusou falha onde o comportamento estava certo.)
const semAcesso = await gql(`{ order(id:"${orderId}"){ id status } }`, D.accessToken);
check(!!semAcesso.errors, 'antes de aceitar, o ENTREGADOR nem consegue ver o pedido', semAcesso.errors?.[0]?.message);

const roubo = await gql(`{ meuCodigoDeEntrega(orderId:"${orderId}") }`, D.accessToken);
check(!!roubo.errors, 'o ENTREGADOR NÃO consegue ler o código do cliente', roubo.errors?.[0]?.message);

const rouboLoja = await gql(`{ codigoDaMinhaLoja(orderId:"${orderId}") }`, D.accessToken);
check(!!rouboLoja.errors, 'o ENTREGADOR NÃO consegue ler o código da loja', rouboLoja.errors?.[0]?.message);

const rouboCliente = await gql(`{ meuCodigoDeEntregador(orderId:"${orderId}") }`, C.accessToken);
check(!!rouboCliente.errors, 'o CLIENTE NÃO consegue ler o código do entregador', rouboCliente.errors?.[0]?.message);

// ─────────────────────────────────────────── até o READY
console.log('\n=== levando o pedido até READY ===');
const sup = await login('superadmin@bcmtech.com');
await must(`mutation{ simulatePayment(orderId:"${orderId}"){ status } }`, sup.accessToken, 'simulatePayment');
for (const s of ['ACCEPTED', 'PREPARING', 'READY']) {
  await must(`mutation{ updateOrderStatus(id:"${orderId}",status:${s}){ status } }`, V.accessToken, s);
}
check(true, 'pedido em READY');

// ─────────────────────────────────────────── ordem obrigatória
console.log('\n=== ORDEM obrigatória ===');
const semColeta = await gql(`mutation{ registrarCodigoDoCliente(orderId:"${orderId}",codigo:"${codsNoBanco[1]}"){ id } }`, D.accessToken);
check(!!semColeta.errors, 'não dá para registrar o código do CLIENTE antes da coleta', semColeta.errors?.[0]?.message?.slice(0, 80));

// ─────────────────────────────────────────── aceite e código do entregador
await must(`mutation{ acceptDelivery(orderId:"${orderId}"){ id } }`, D.accessToken, 'acceptDelivery');
await sleep(400);
const codEnt = sql(`SELECT COALESCE("codigoEntregador",'-') FROM orders WHERE id='${orderId}'`);
check(/^\d{6}$/.test(codEnt), 'código do ENTREGADOR gerado no aceite da corrida', codEnt);
check(codEnt !== codsNoBanco[0], 'código do entregador é distinto do da loja');

// cada um lê o SEU
const leLoja = await gql(`{ codigoDaMinhaLoja(orderId:"${orderId}") }`, V.accessToken);
check(leLoja.data?.codigoDaMinhaLoja === codsNoBanco[0], 'o LOJISTA lê o próprio código');
const leEnt = await gql(`{ meuCodigoDeEntregador(orderId:"${orderId}") }`, D.accessToken);
check(leEnt.data?.meuCodigoDeEntregador === codEnt, 'o ENTREGADOR lê o próprio código');
const leCli = await gql(`{ meuCodigoDeEntrega(orderId:"${orderId}") }`, C.accessToken);
check(leCli.data?.meuCodigoDeEntrega === codsNoBanco[1], 'o CLIENTE lê o próprio código');

// A checagem de vazamento que importa: AGORA ele tem acesso ao pedido.
const comAcesso = await gql(`{ order(id:"${orderId}"){ id status orderNumber total notes deliveryAddress } }`, D.accessToken);
const corpo = JSON.stringify(comAcesso.data || {});
const vazouAlgum = [codsNoBanco[0], codsNoBanco[1], codEnt].some((c) => corpo.includes(c));
check(!comAcesso.errors, 'depois de aceitar, o ENTREGADOR consulta o pedido normalmente', comAcesso.errors?.[0]?.message);
check(!vazouAlgum, 'e a consulta do pedido NAO devolve nenhum dos 3 codigos');

// ─────────────────────────────────────────── botões antigos bloqueados
console.log('\n=== os BOTÕES antigos não podem contornar ===');
const botaoVendor = await gql(`mutation{ vendorConfirmPickup(orderId:"${orderId}"){ status } }`, V.accessToken);
check(!!botaoVendor.errors, 'vendorConfirmPickup recusado em pedido com código', botaoVendor.errors?.[0]?.message?.slice(0, 70));

// ─────────────────────────────────────────── quem digita o quê
console.log('\n=== quem digita o quê ===');
const trocado = await gql(`mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"${codsNoBanco[0]}"){ id } }`, V.accessToken);
check(!!trocado.errors, 'o LOJISTA não pode registrar o próprio código (quem digita é o entregador)', trocado.errors?.[0]?.message?.slice(0, 70));

// ─────────────────────────────────────────── força bruta
console.log('\n=== força bruta no código da loja ===');
let bloqueou = false;
for (let i = 1; i <= 6; i++) {
  const r = await gql(`mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"000000"){ id } }`, D.accessToken);
  const msg = r.errors?.[0]?.message || '';
  if (/muitas tentativas/i.test(msg)) { bloqueou = true; check(true, `bloqueou na tentativa ${i}`, msg.slice(0, 60)); break; }
}
check(bloqueou, 'excesso de tentativas BLOQUEIA');
// limpa o bloqueio para seguir o teste
sql(`UPDATE orders SET "codigoBloqueadoAte"=NULL, "codigoTentativas"=0 WHERE id='${orderId}'`);

// ─────────────────────────────────────────── a coleta
console.log('\n=== COLETA: troca mútua de códigos ===');
await must(`mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"${codsNoBanco[0]}",latitude:-31.77,longitude:-52.34){ status } }`, D.accessToken, 'entregador digita o código da loja');
check(true, 'ENTREGADOR registrou o código da loja');
const statusMeio = sql(`SELECT status FROM orders WHERE id='${orderId}'`);
check(statusMeio === 'READY', 'com só um dos dois, o pedido NÃO avança', statusMeio);

const r2 = await must(`mutation{ registrarCodigoDoEntregador(orderId:"${orderId}",codigo:"${codEnt}"){ status } }`, V.accessToken, 'lojista digita o código do entregador');
check(r2.registrarCodigoDoEntregador.status === 'DELIVERING', 'com o PAR completo, o pedido vai para DELIVERING', r2.registrarCodigoDoEntregador.status);
const gps = sql(`SELECT COALESCE("codigoVendedorLat"::text,'-') FROM orders WHERE id='${orderId}'`);
check(gps !== '-', 'o GPS do entregador foi gravado na coleta', gps);

// repetir não pode
const repete = await gql(`mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"${codsNoBanco[0]}"){ id } }`, D.accessToken);
check(!!repete.errors, 'o mesmo código não pode ser registrado duas vezes', repete.errors?.[0]?.message?.slice(0, 60));

// ─────────────────────────────────────────── a entrega
console.log('\n=== ENTREGA: o código do cliente LIBERA ===');
const antesSettle = sql(`SELECT "isSettled" FROM orders WHERE id='${orderId}'`);
check(antesSettle === 'f', 'antes do código do cliente, o pedido NÃO está liquidado', antesSettle);

const fim = await must(`mutation{ registrarCodigoDoCliente(orderId:"${orderId}",codigo:"${codsNoBanco[1]}",latitude:-31.76,longitude:-52.33){ status } }`, D.accessToken, 'entregador digita o código do cliente');
check(fim.registrarCodigoDoCliente.status === 'COMPLETED', 'o 3º código leva o pedido a COMPLETED', fim.registrarCodigoDoCliente.status);
const depoisSettle = sql(`SELECT "isSettled" FROM orders WHERE id='${orderId}'`);
check(depoisSettle === 't', 'o repasse foi disparado (isSettled)', depoisSettle);
const confirmado = sql(`SELECT CASE WHEN "codigoClienteUsadoEm" IS NOT NULL THEN 'sim' ELSE 'nao' END FROM orders WHERE id='${orderId}'`);
check(confirmado === 'sim', 'o registro do código do cliente ficou gravado');
const gpsCli = sql(`SELECT COALESCE("codigoClienteLat"::text,'-') FROM orders WHERE id='${orderId}'`);
check(gpsCli !== '-', 'o GPS da entrega foi gravado (evidência p/ chargeback)', gpsCli);

// A PROVA DE RECEBIMENTO. Esta verificação existe porque eu esqueci de gravar
// `customerConfirmedAt` na primeira versão: o pedido ficava COMPLETED e
// LIQUIDADO com a prova nula — o mesmo bug que a auditoria já havia corrigido
// no caminho da automação por GPS. Sem ela, numa disputa ou chargeback a
// plataforma não consegue demonstrar quando e como a entrega foi confirmada,
// tendo já repassado a vendedor e entregador.
const prova = sql(`SELECT CASE WHEN \"customerConfirmedAt\" IS NOT NULL THEN 'sim' ELSE 'nao' END FROM orders WHERE id='${orderId}'`);
check(prova === 'sim', 'a PROVA DE RECEBIMENTO (customerConfirmedAt) foi gravada', prova);

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((f) => console.log(' - ' + f)); process.exit(1); }
