// ═══════════════════════════════════════════════════════════════════════════
// KAN-102 — O PAINEL FINANCEIRO FECHA A CONTA?
// ═══════════════════════════════════════════════════════════════════════════
//
// Um painel de dinheiro errado é pior que nenhum: decisão de preço, de plano e
// de corte de custo sai dele. Então a prova não confere "a tela abriu" — ela
// confere a ARITMÉTICA, contra pedidos que este script mesmo cria, com valores
// conhecidos, nas duas modalidades que mudam a divisão:
//
//   RETIRADA ............... não tem frete; a loja fica com total - comissão
//   ENTREGA PELO APP ....... o frete é da PLATAFORMA; a loja fica com
//                            total - comissão - frete
//
// E a invariante que amarra tudo:
//
//   volume = parte dos vendedores + comissão da plataforma + frete da plataforma
//
// Se alguém mexer numa das fórmulas sem mexer nas outras, esta linha quebra.
import { execSync } from 'node:child_process';
import { RECEBEDOR_VENDEDOR } from './recebedores-de-teste.mjs';

const URL = 'http://localhost:3000/graphql';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
const titulo = (t) => console.log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reais = (n) => `R$ ${Number(n).toFixed(2)}`;
const perto = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) < tol;

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

const ts = Date.now();
const suf = String(ts).slice(-6);
const PRECO = 100.0;

titulo('1. CENÁRIO COM VALORES CONHECIDOS');

const vemail = `fin_v_${ts}@t.com`;
await must(
  `mutation{ registerVendor(input:{name:"Lojista Financeiro",email:"${vemail}",password:"teste123",phone:"5347${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerVendor',
);
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
// PRO = 2% de comissão. O número do plano importa: é ele que o painel usa
// para mostrar o percentual médio cobrado por loja.
sql(
  `UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, ` +
  `"pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}', "vendorPlan"='PRO', "acceptedSubscriptionTermsAt"=now() WHERE id='${vid}'`,
);
const V = await login(vemail, 'vendor');

const st = await must(
  `mutation{ createStore(input:{name:"Loja Financeira ${suf}",phone:"5391000",street:"R",number:"1",` +
  `neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,` +
  `latitude:-31.7700,longitude:-52.3400,deliveryFee:10.00,freeDelivery:false}){ id } }`,
  V, 'createStore',
);
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"Mercearia",storeId:"${storeId}"){ id } }`, V, 'createCategory');
const prod = await must(
  `mutation{ createProduct(input:{name:"Cesta Fin",price:${PRECO},stock:50,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`,
  V, 'createProduct',
);
const produtoId = prod.createProduct.id;
if (sql(`SELECT "isOpen" FROM stores WHERE id='${storeId}'`) !== 't') {
  await must(`mutation{ toggleStoreOpen(id:"${storeId}"){ id } }`, V, 'toggleStoreOpen');
}

const cemail = `fin_c_${ts}@t.com`;
await must(
  `mutation{ registerApp(input:{name:"Cliente Fin",email:"${cemail}",password:"teste123",phone:"5348${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerApp',
);
const C = await login(cemail);

// (a) RETIRADA: sem frete
const retirada = await must(
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${produtoId}",quantity:1}],` +
  `paymentMethod:"PIX",isPickup:true}){ id orderNumber total deliveryFee commissionAmount subtotal } }`,
  C, 'createOrder retirada',
);
// (b) ENTREGA PELO APP: o frete é da plataforma
const entrega = await must(
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${produtoId}",quantity:2}],` +
  `paymentMethod:"PIX",deliveryAddress:"Rua do Cliente 50",deliveryLatitude:-31.7600,deliveryLongitude:-52.3300})` +
  `{ id orderNumber total deliveryFee commissionAmount subtotal } }`,
  C, 'createOrder entrega',
);

const A = retirada.createOrder, B = entrega.createOrder;
check(Number(A.deliveryFee) === 0, 'pedido de retirada sem frete', reais(A.deliveryFee));
check(Number(B.deliveryFee) > 0, 'pedido com entrega pelo app tem frete', reais(B.deliveryFee));

// Os pedidos nascem AWAITING_PAYMENT (PIX). O painel NÃO pode contá-los
// enquanto não forem pagos — faturamento que não entrou.
titulo('2. PEDIDO NÃO PAGO NÃO ENTRA NO FATURAMENTO');
const sup = await login('superadmin@bcmtech.com');
const antes = await must(
  `{ painelFinanceiro(dias:1){ resumo{ pedidosPagos volumeVendido } } }`,
  sup, 'painelFinanceiro antes',
);
const volumeAntes = Number(antes.painelFinanceiro.resumo.volumeVendido);
const idsDesteTeste = `('${A.id}','${B.id}')`;
const statusAgora = sql(`SELECT string_agg(status::text, ',') FROM orders WHERE id IN ${idsDesteTeste}`);
check(
  /AWAITING_PAYMENT/.test(statusAgora),
  'os dois pedidos estão aguardando pagamento',
  statusAgora,
);

await must(`mutation{ simulatePayment(orderId:"${A.id}"){ id status } }`, sup, 'simulatePayment A');
await must(`mutation{ simulatePayment(orderId:"${B.id}"){ id status } }`, sup, 'simulatePayment B');
await sleep(600);

titulo('3. A CONTA DO PAINEL');
const painel = (await must(
  `{ painelFinanceiro(dias:1){
       periodoDias
       resumo{ pedidosPagos volumeVendido comissaoDaPlataforma freteTotal freteDaPlataforma parteDosVendedores emCustodia }
       repasses{ vendedoresLiquidados vendedoresPendentes passivoDeVendedores passivoDeEntregadores passivoJaPago }
       porLoja{ storeId storeName pedidos volume comissao parteDaLoja aReceber percentualMedioDeComissao }
       porDia{ dia volume comissao }
     } }`,
  sup, 'painelFinanceiro',
)).painelFinanceiro;

const r = painel.resumo;
check(r.volumeVendido > volumeAntes, 'o volume subiu depois do pagamento',
  `${reais(volumeAntes)} -> ${reais(r.volumeVendido)}`);

// A INVARIANTE
check(
  perto(r.volumeVendido, r.parteDosVendedores + r.comissaoDaPlataforma + r.freteDaPlataforma),
  'volume = parte dos vendedores + comissão + frete da plataforma',
  `${reais(r.volumeVendido)} = ${reais(r.parteDosVendedores)} + ${reais(r.comissaoDaPlataforma)} + ${reais(r.freteDaPlataforma)}`,
);

// A loja do teste, isolada das demais do período
const loja = painel.porLoja.find((l) => l.storeId === storeId);
check(!!loja, 'a loja do teste aparece na lista por loja');
if (loja) {
  const volumeEsperado = Number(A.total) + Number(B.total);
  const comissaoEsperada = Number(A.commissionAmount) + Number(B.commissionAmount);
  // retirada: loja fica com total - comissão | entrega: menos o frete também
  const parteEsperada =
    (Number(A.total) - Number(A.commissionAmount)) +
    (Number(B.total) - Number(B.commissionAmount) - Number(B.deliveryFee));

  check(loja.pedidos === 2, 'os dois pedidos contados', String(loja.pedidos));
  check(perto(loja.volume, volumeEsperado), 'volume da loja bate com os pedidos',
    `${reais(loja.volume)} vs ${reais(volumeEsperado)}`);
  check(perto(loja.comissao, comissaoEsperada), 'comissão da loja bate',
    `${reais(loja.comissao)} vs ${reais(comissaoEsperada)}`);
  check(perto(loja.parteDaLoja, parteEsperada),
    'parte da loja desconta a comissão SEMPRE e o frete SÓ na entrega pelo app',
    `${reais(loja.parteDaLoja)} vs ${reais(parteEsperada)}`);
  check(perto(loja.percentualMedioDeComissao, 2, 0.051),
    'percentual médio cobrado = 2% (plano PRO)', `${loja.percentualMedioDeComissao}%`);
}

// Custódia: PIX com split liquida na hora (settledViaSplit); o que não
// liquidou fica em custódia. Os dois números juntos têm que cobrir o volume.
check(r.emCustodia >= 0 && r.emCustodia <= r.volumeVendido,
  'custódia é um pedaço do volume, nunca maior que ele',
  `${reais(r.emCustodia)} de ${reais(r.volumeVendido)}`);

const somaPorLoja = painel.porLoja.reduce((s, l) => s + Number(l.volume), 0);
check(perto(somaPorLoja, r.volumeVendido, 0.05),
  'a soma das lojas fecha com o volume do resumo',
  `${reais(somaPorLoja)} vs ${reais(r.volumeVendido)}`);

const somaPorDia = painel.porDia.reduce((s, d) => s + Number(d.volume), 0);
check(perto(somaPorDia, r.volumeVendido, 0.05),
  'a soma dos dias fecha com o volume do resumo',
  `${reais(somaPorDia)} vs ${reais(r.volumeVendido)}`);

titulo('4. O PAINEL É SÓ DO SUPERADMIN');
const semToken = await gql(`{ painelFinanceiro(dias:1){ periodoDias } }`);
check(!!semToken.errors, 'sem login, negado', semToken.errors?.[0]?.message?.slice(0, 40));
const comCliente = await gql(`{ painelFinanceiro(dias:1){ periodoDias } }`, C);
check(!!comCliente.errors, 'logado como CLIENTE, negado', comCliente.errors?.[0]?.message?.slice(0, 40));
const comLojista = await gql(`{ painelFinanceiro(dias:1){ periodoDias } }`, V);
check(!!comLojista.errors, 'logado como LOJISTA, negado — ele veria o faturamento dos concorrentes',
  comLojista.errors?.[0]?.message?.slice(0, 40));

titulo(`RESULTADO: ${ok.length} ok, ${fail.length} falha(s)`);
if (fail.length) {
  for (const f of fail) console.log(`   ❌ ${f}`);
  process.exit(1);
}
console.log('   o painel fecha a conta.');
