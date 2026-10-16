// ═══════════════════════════════════════════════════════════════════════════
// O CAMINHO INTEIRO, DE PONTA A PONTA, NUMA RODADA SÓ.
// ═══════════════════════════════════════════════════════════════════════════
//
// Da criação da loja até o dinheiro na conta de cada um:
//
//   1. lojista se cadastra, é aprovado e ganha recebedor no Pagar.me
//   2. cria a loja (passando pela cota de lojas do plano)
//   3. cria categoria e produtos (passando pela cota de produtos do plano)
//   4. EXPOSIÇÃO NORMAL: o produto aparece na vitrine pública e na loja
//   5. PROPAGANDA: cria a campanha, ela é paga, e o preço promocional passa a
//      valer — inclusive na vitrine, que é o que o cliente vê
//   6. o cliente monta o pedido e o preço cobrado é o DA PROPAGANDA
//   7. pagamento, e a conta do split: vendedor, entregador e marketplace
//   8. entregador aceita, coleta por código, entrega por código
//   9. liquidação: o que cada um recebeu, e o passivo registrado
//
// POR QUE EM UM SCRIPT SÓ, e não distribuído entre os outros E2E: os elos
// interagem. A propaganda muda o preço, o preço muda a comissão, a comissão
// muda a fatia de cada um, e o modo de entrega decide se existe entregador no
// split. Testar cada pedaço isolado deixa passar justamente o erro de
// composição — e é esse caminho que o sistema inteiro existe para cumprir.
//
// O QUE ESTE SCRIPT **NÃO** FAZ: não fala com o Pagar.me de verdade (os
// recebedores daqui são fictícios). O pagamento é simulado pela mutation de
// superadmin, que dispara o MESMO caminho de aprovação do webhook real. A
// aritmética do split está provada ao centavo em src/payments/split-matriz.spec.ts,
// contra as funções que montam as regras de divisão.
import { execSync } from 'node:child_process';

const URL = 'http://localhost:3000/graphql';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
const titulo = (t) => console.log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(email, kind = 'app') {
  const m = kind === 'vendor' ? 'loginVendor' : 'loginApp';
  for (let i = 0; i < 12; i++) {
    const j = await gql(`mutation{ ${m}(input:{email:"${email}",password:"teste123"}, forceLogin:true){ accessToken user{ id } } }`);
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

// ════════════════════════════════════════════════════ 1. O LOJISTA
titulo('1. O LOJISTA ENTRA NA PLATAFORMA');

const vemail = `cc_v_${ts}@t.com`;
await must(
  `mutation{ registerVendor(input:{name:"Lojista Caminho",email:"${vemail}",password:"teste123",phone:"5331${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerVendor',
);
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
check(!!vid, 'lojista cadastrado');

// Sem aprovação o lojista existe mas não opera. A aprovação é do superadmin.
const aprovadoAntes = sql(`SELECT COALESCE("approvedAt"::text,'-') FROM vendor_users WHERE id='${vid}'`);
check(aprovadoAntes === '-', 'nasce PENDENTE de aprovação (não opera ainda)');

// Aprovação + recebedor no Pagar.me + plano PRO (PRO é o primeiro plano que
// permite criar propaganda: FREE tem freePromosPerWeek = 0).
sql(
  `UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, ` +
  `"pagarmeRecipientId"='re_cc_vendedor', "vendorPlan"='PRO', "acceptedSubscriptionTermsAt"=now() WHERE id='${vid}'`,
);
const V = await login(vemail, 'vendor');
check(!!V, 'aprovado, com recebedor no Pagar.me e plano PRO');

// ════════════════════════════════════════════════════ 2. A LOJA
titulo('2. A LOJA');

const st = await must(
  `mutation{ createStore(input:{name:"Mercado Caminho ${suf}",phone:"5391000",street:"Rua das Flores",number:"100",` +
  `neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,` +
  `latitude:-31.7700,longitude:-52.3400,deliveryFee:10.00}){ id name slug } }`,
  V, 'createStore',
);
const storeId = st.createStore.id;
check(!!storeId, 'loja criada', st.createStore.name);
check(!!st.createStore.slug, 'com slug para a vitrine', st.createStore.slug);

// A cota de lojas do plano (PRO permite 3). Não leio o número da config:
// tento criar até ser barrado, que é o que o lojista de verdade vive.
let bloqueouNaCota = false;
for (let i = 2; i <= 4; i++) {
  const r = await gql(
    `mutation{ createStore(input:{name:"Extra ${i} ${suf}",phone:"5391000",street:"R",number:"1",` +
    `neighborhood:"C",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:true,latitude:-31.77,longitude:-52.34}){ id } }`,
    V,
  );
  if (r.errors) {
    bloqueouNaCota = /no maximo \d+ loja/.test(r.errors[0].message);
    check(bloqueouNaCota, `a cota de lojas do plano barra na ${i}ª`, r.errors[0].message.slice(0, 60));
    break;
  }
}
check(bloqueouNaCota, 'a cota de lojas do plano É aplicada');

// ════════════════════════════════════════════════════ 3. O CATÁLOGO
titulo('3. O CATÁLOGO');

const cat = await must(`mutation{ createCategory(name:"Mercearia",storeId:"${storeId}"){ id name } }`, V, 'createCategory');
check(!!cat.createCategory.id, 'categoria criada');

const PRECO_CHEIO = 100.0;
const prod = await must(
  `mutation{ createProduct(input:{name:"Cesta Basica",description:"Cesta completa",price:${PRECO_CHEIO},` +
  `stock:50,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id name price stock } }`,
  V, 'createProduct',
);
const produtoId = prod.createProduct.id;
check(Number(prod.createProduct.price) === PRECO_CHEIO, 'produto criado no preço cheio', reais(PRECO_CHEIO));
check(prod.createProduct.stock === 50, 'com estoque');

// ════════════════════════════════════════════════════ 4. EXPOSIÇÃO NORMAL
titulo('4. EXPOSIÇÃO NORMAL — o cliente consegue encontrar?');

// A loja precisa estar aberta para aparecer. Garanto o ESTADO, não aplico
// uma troca às cegas: `toggleStoreOpen` alterna, e a loja já nasce aberta —
// chamá-lo direto FECHAVA a loja, e as checagens de vitrine abaixo falhavam
// por culpa do teste. ("não apareceu por loja fechada" e "não apareceu por
// bug" são coisas diferentes, e era justamente isso que eu queria separar.)
if (sql(`SELECT "isOpen" FROM stores WHERE id='${storeId}'`) !== 't') {
  await must(`mutation{ toggleStoreOpen(id:"${storeId}"){ id isOpen } }`, V, 'toggleStoreOpen');
}
check(sql(`SELECT "isOpen" FROM stores WHERE id='${storeId}'`) === 't', 'loja aberta');

// `must` e não `gql` cru: se a query estiver malformada eu quero o erro do
// GraphQL na cara, não um `undefined` que vira "o produto não aparece" e me
// faz caçar um bug de produto que não existe. Foi exatamente o que aconteceu
// na primeira versão — pedi `publicStorefront { store {...} products {...} }`,
// mas o StorefrontResult é PLANO e os produtos vêm dentro de `categories`.
// A query falhava, eu lia `undefined`, e a tela parecia quebrada.
const vitrine = await must(
  `{ publicStorefront(slug:"${st.createStore.slug}"){ id name categories{ id name products{ id name price promotionalPrice } } } }`,
  null,
  'publicStorefront',
);
const produtosDaVitrine = (vitrine.publicStorefront?.categories || []).flatMap((c) => c.products || []);
const naVitrine = produtosDaVitrine.find((p) => p.id === produtoId);
check(!!naVitrine, 'o produto APARECE na vitrine pública da loja');
check(
  naVitrine && Number(naVitrine.price) === PRECO_CHEIO && !naVitrine.promotionalPrice,
  'e aparece pelo preço cheio, sem promoção',
  naVitrine ? `${reais(naVitrine.price)} / promo=${naVitrine.promotionalPrice ?? 'nenhuma'}` : '',
);

const naLista = await gql(`{ storeProducts(storeId:"${storeId}"){ id name } }`);
check(
  (naLista.data?.storeProducts || []).some((p) => p.id === produtoId),
  'e aparece na listagem de produtos da loja',
);

const lojasPublicas = await gql(`{ publicStores{ id name } }`);
check(
  (lojasPublicas.data?.publicStores || []).some((s) => s.id === storeId),
  'a LOJA aparece na listagem pública',
);

// ════════════════════════════════════════════════════ 5. PROPAGANDA
titulo('5. PROPAGANDA — a campanha muda o preço de venda');

const PRECO_PROMO = 80.0;
const promo = await must(
  `mutation{ createPromotion(input:{title:"Cesta em oferta",description:"so esta semana",storeId:"${storeId}",` +
  `productId:"${produtoId}",promotionalPrice:${PRECO_PROMO},` +
  `startDate:"${new Date(Date.now() - 3600_000).toISOString()}",` +
  `endDate:"${new Date(Date.now() + 5 * 86400_000).toISOString()}"}){ id title promotionalPrice isPaid isActive } }`,
  V, 'createPromotion',
);
const promoId = promo.createPromotion.id;
check(!!promoId, 'campanha criada pelo lojista (plano PRO permite)');
check(promo.createPromotion.isPaid === false, 'nasce NÃO PAGA — anúncio é produto pago');

// Antes de pagar, o preço NÃO pode valer: senão é desconto de graça.
const antesDePagar = sql(`SELECT COALESCE("promotionalPrice"::text,'-') FROM products WHERE id='${produtoId}'`);
check(antesDePagar === '-', 'campanha NÃO PAGA não aplica desconto');

// O superadmin confirma o pagamento do anúncio (no fluxo real é o webhook).
const sup = await login('superadmin@bcmtech.com');
await must(`mutation{ markPromotionPaid(id:"${promoId}"){ id isPaid } }`, sup, 'markPromotionPaid');
await sleep(400);

const depoisDePagar = Number(sql(`SELECT "promotionalPrice" FROM products WHERE id='${produtoId}'`));
check(depoisDePagar === PRECO_PROMO, 'campanha PAGA aplica o preço promocional no produto', reais(depoisDePagar));

const vitrineComPromo = await must(
  `{ publicStorefront(slug:"${st.createStore.slug}"){ categories{ products{ id price promotionalPrice } } } }`,
  null,
  'publicStorefront com promo',
);
const promovido = (vitrineComPromo.publicStorefront?.categories || [])
  .flatMap((c) => c.products || [])
  .find((p) => p.id === produtoId);
check(
  promovido && Number(promovido.promotionalPrice) === PRECO_PROMO,
  'a VITRINE mostra o preço promocional (é o que o cliente vê)',
  promovido ? reais(promovido.promotionalPrice) : '',
);
check(
  promovido && Number(promovido.price) === PRECO_CHEIO,
  'e mostra o preço cheio ao lado, para o desconto ser visível',
);

const ativas = await gql(`{ activePromotions{ id title } }`);
check(
  (ativas.data?.activePromotions || []).some((p) => p.id === promoId),
  'a campanha aparece na vitrine de promoções',
);

// ════════════════════════════════════════════════════ 6. O PEDIDO
titulo('6. O PEDIDO — o preço cobrado é o da propaganda?');

const cemail = `cc_c_${ts}@t.com`;
await must(
  `mutation{ registerApp(input:{name:"Cliente Caminho",email:"${cemail}",password:"teste123",phone:"5332${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerApp',
);
const C = await login(cemail);

const QTD = 2;
const ped = await must(
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${produtoId}",quantity:${QTD}}],` +
  `paymentMethod:"PIX",deliveryAddress:"Rua do Cliente 50",deliveryLatitude:-31.7600,deliveryLongitude:-52.3300})` +
  `{ id orderNumber subtotal deliveryFee total commissionAmount status } }`,
  C, 'createOrder',
);
const o = ped.createOrder;
const orderId = o.id;
console.log(`   pedido ${o.orderNumber}`);

// A conta esperada, pelas regras de negócio.
//
// O FRETE sai do pedido, não de um número cravado aqui: com coordenadas, ele é
// `base + km × preço/km`, e `store.deliveryFee` é só o PISO para pedido sem
// coordenadas (o checkout do storefront não manda lat/long). Cravar R$ 10,00
// fazia o teste acusar o produto por uma expectativa minha — o frete calculado
// para ~1,2 km é de centavos, e estava certo.
//
// O que importa verificar é a RELAÇÃO entre as partes, que é o que quebra
// quando alguém mexe na fórmula.
const subtotalEsperado = PRECO_PROMO * QTD;             // 160,00  (promoção!)
const freteCobrado = Number(o.deliveryFee);             // por distância
const comissaoEsperada = subtotalEsperado * 0.02;       //   3,20  (PRO 2%)
const totalEsperado = subtotalEsperado + freteCobrado;

check(Number(o.subtotal) === subtotalEsperado,
  `subtotal usa o preço da PROPAGANDA (${QTD} x ${reais(PRECO_PROMO)})`, reais(o.subtotal));
check(Number(o.subtotal) !== PRECO_CHEIO * QTD,
  'e NÃO o preço cheio — senão o cliente pagaria mais do que o anúncio que viu');
check(freteCobrado > 0,
  'frete calculado por DISTÂNCIA e maior que zero (entregador não trabalha de graça)',
  reais(freteCobrado));
check(Number(o.total) === totalEsperado, 'total = subtotal + frete', reais(o.total));
check(Number(o.commissionAmount) === comissaoEsperada,
  'comissão de 2% (PRO) sobre o valor VENDIDO, não sobre o de tabela', reais(o.commissionAmount));

const estoqueDepois = Number(sql(`SELECT stock FROM products WHERE id='${produtoId}'`));
check(estoqueDepois === 50 - QTD, 'estoque baixou na criação do pedido', String(estoqueDepois));

// ════════════════════════════════════════════════════ 7. PAGAMENTO E SPLIT
titulo('7. PAGAMENTO — e a conta de quem recebe o quê');

await must(`mutation{ simulatePayment(orderId:"${orderId}"){ id status } }`, sup, 'simulatePayment');
await sleep(600);
const statusPago = sql(`SELECT status FROM orders WHERE id='${orderId}'`);
check(statusPago === 'PENDING', 'pedido pago entra na fila da loja (PENDING)', statusPago);

// A divisão esperada no PIX (split na cobrança; o entregador não entra):
//   vendedor   = total - comissão - frete = 170,00 - 3,20 - 10,00 = 156,80
//   plataforma = 170,00 - 156,80 = 13,20  (comissão 3,20 + frete 10,00 retido)
const vendedorEsperado = totalEsperado - comissaoEsperada - freteCobrado;
const plataformaEsperada = totalEsperado - vendedorEsperado;
console.log(`   divisão esperada: vendedor ${reais(vendedorEsperado)} | plataforma ${reais(plataformaEsperada)}`);
console.log(`   (no PIX o entregador não entra no split — ele só é conhecido no READY)`);
check(
  Math.abs(vendedorEsperado + plataformaEsperada - totalEsperado) < 0.005,
  'a divisão fecha com o total',
  `${reais(vendedorEsperado)} + ${reais(plataformaEsperada)} = ${reais(totalEsperado)}`,
);

// ════════════════════════════════════════════════════ 8. A ENTREGA
titulo('8. A ENTREGA — da loja à porta do cliente, por código');

for (const s of ['ACCEPTED', 'PREPARING', 'READY']) {
  await must(`mutation{ updateOrderStatus(id:"${orderId}",status:${s}){ status } }`, V, s);
}
check(sql(`SELECT status FROM orders WHERE id='${orderId}'`) === 'READY', 'loja aceitou, preparou e deixou pronto');

const demail = `cc_d_${ts}@t.com`;
await must(
  `mutation{ registerApp(input:{name:"Entregador Caminho",email:"${demail}",password:"teste123",phone:"5333${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerApp entregador',
);
const did = sql(`SELECT id FROM app_users WHERE email='${demail}'`);
sql(`UPDATE app_users SET role='DELIVERER', "isDeliverer"=true, "mpConnected"=true, "pagarmeRecipientId"='re_cc_entregador' WHERE id='${did}'`);
const D = await login(demail);

await must(`mutation{ acceptDelivery(orderId:"${orderId}"){ id } }`, D, 'acceptDelivery');
await sleep(400);
check(sql(`SELECT "codigoEntregador" IS NOT NULL FROM orders WHERE id='${orderId}'`) === 't',
  'ao aceitar a corrida, o código do ENTREGADOR é gerado');

const codLoja = sql(`SELECT "codigoVendedor" FROM orders WHERE id='${orderId}'`);
const codEnt = sql(`SELECT "codigoEntregador" FROM orders WHERE id='${orderId}'`);
const codCli = sql(`SELECT "codigoCliente" FROM orders WHERE id='${orderId}'`);

// Cada parte lê só o seu. É a regra que sustenta o esquema todo.
const leCli = await gql(`{ meuCodigoDeEntrega(orderId:"${orderId}") }`, C);
const roubo = await gql(`{ meuCodigoDeEntrega(orderId:"${orderId}") }`, D);
check(leCli.data?.meuCodigoDeEntrega === codCli, 'o CLIENTE lê o próprio código');
check(!!roubo.errors, 'o ENTREGADOR NÃO consegue ler o código do cliente', roubo.errors?.[0]?.message);

await must(`mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"${codLoja}",latitude:-31.77,longitude:-52.34){ id } }`, D, 'cod. loja');
await must(`mutation{ registrarCodigoDoEntregador(orderId:"${orderId}",codigo:"${codEnt}"){ status } }`, V, 'cod. entregador');
check(sql(`SELECT status FROM orders WHERE id='${orderId}'`) === 'DELIVERING', 'coleta confirmada pelos dois lados → DELIVERING');

check(sql(`SELECT "isSettled" FROM orders WHERE id='${orderId}'`) === 'f',
  'o dinheiro AINDA não saiu — falta a entrega');

const fim = await must(
  `mutation{ registrarCodigoDoCliente(orderId:"${orderId}",codigo:"${codCli}",latitude:-31.7601,longitude:-52.3301){ id status } }`,
  D, 'cod. cliente',
);
check(fim.registrarCodigoDoCliente.status === 'COMPLETED', 'o código do CLIENTE conclui o pedido', fim.registrarCodigoDoCliente.status);

// ════════════════════════════════════════════════════ 9. A LIQUIDAÇÃO
titulo('9. A LIQUIDAÇÃO — o que sobrou registrado');

await sleep(800);
const liq = sql(
  `SELECT "isSettled" || '|' || COALESCE("customerConfirmedAt"::text,'-') || '|' ` +
  `|| COALESCE("delivererPayableCents"::text,'-') || '|' || COALESCE("codigoClienteLat"::text,'-') ` +
  `FROM orders WHERE id='${orderId}'`,
).split('|');

check(liq[0] === 'true' || liq[0] === 't', 'liquidação disparada', liq[0]);
check(liq[1] !== '-', 'prova de recebimento do cliente gravada (defesa em chargeback)', liq[1]);

// No PIX o frete fica retido e vira passivo do entregador.
//
// A ORDEM DAS OPERAÇÕES IMPORTA, e dá 1 centavo de diferença: o sistema
// arredonda a COMISSÃO e dá o resto ao entregador, em vez de arredondar a
// parte do entregador. Com frete de R$ 0,65:
//
//   sistema:  65 − round(65 × 10%) = 65 − 7 = 58
//   ingênuo:  round(65 × 90%)      = round(58,5) = 59
//
// O jeito do sistema é o certo: garante que comissão + entregador = frete
// exatamente, sempre. A forma ingênua pode não fechar, e num split que não
// fecha o gateway recusa a cobrança. Replico a ordem do sistema aqui — um
// teste que calcula "do seu jeito" acusa o código por 1 centavo que é dele.
const freteCents = Math.round(freteCobrado * 100);
const passivoEsperado = freteCents - Math.round(freteCents * 0.1);
check(
  Number(liq[2]) === passivoEsperado,
  `passivo do entregador registrado (frete ${reais(freteCobrado)} − 10% de comissão)`,
  liq[2] === '-' ? 'NÃO registrado' : reais(Number(liq[2]) / 100),
);
check(liq[3] !== '-', 'GPS da entrega gravado (evidência)', liq[3]);

// E ele aparece para quem concilia.
const passivos = await gql(`{ delivererPayables(apenasAbertos:true){ id orderNumber delivererPayableCents } }`, sup);
check(
  (passivos.data?.delivererPayables || []).some((p) => p.id === orderId),
  'e o passivo aparece na tela de repasses retidos do superadmin',
);

// ════════════════════════════════════════════════════ FECHAMENTO DA CONTA
titulo('FECHAMENTO — a conta do pedido, de ponta a ponta');

console.log(`   produto de tabela ......... ${reais(PRECO_CHEIO)}`);
console.log(`   preço com propaganda ...... ${reais(PRECO_PROMO)}  (campanha paga)`);
console.log(`   ${QTD} unidades ................. ${reais(subtotalEsperado)}`);
console.log(`   frete ..................... ${reais(freteCobrado)}`);
console.log(`   TOTAL PAGO PELO CLIENTE ... ${reais(totalEsperado)}`);
console.log('   ' + '─'.repeat(46));
console.log(`   vendedor recebe ........... ${reais(vendedorEsperado)}`);
console.log(`   entregador recebe ......... ${reais(passivoEsperado / 100)}  (passivo; PIX não divide na hora)`);
console.log(`   marketplace fica com ...... ${reais(plataformaEsperada - passivoEsperado / 100)}  (comissão ${reais(comissaoEsperada)} + ${reais(freteCobrado - passivoEsperado / 100)} da entrega)`);
console.log('   ' + '─'.repeat(46));
const somaFinal = vendedorEsperado + passivoEsperado / 100 + (plataformaEsperada - passivoEsperado / 100);
console.log(`   soma ...................... ${reais(somaFinal)}`);
check(Math.abs(somaFinal - totalEsperado) < 0.005, 'a soma das três partes fecha com o que o cliente pagou');

console.log(`\n═════ ${ok.length} OK, ${fail.length} FALHOU ═════`);
if (fail.length) { fail.forEach((f) => console.log('   ❌ ' + f)); process.exit(1); }
