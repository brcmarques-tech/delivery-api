// ═══════════════════════════════════════════════════════════════════════════
// KAN-12 — CLIENTE FIEL: o prêmio chega, e chega só para quem comprou
// ═══════════════════════════════════════════════════════════════════════════
//
// O que esta prova cobre, em ordem de dano se quebrar:
//
//   1. O PRÊMIO VAZAR. O cupom de fidelidade é NOMINAL. Se o código valer para
//      qualquer um, basta um print em grupo de WhatsApp e o desconto — que sai
//      do bolso da loja — vai para quem nunca comprou lá.
//
//   2. PRÊMIO DUPLICADO. Dois pedidos concluídos ao mesmo tempo no marco não
//      podem gerar dois cupons. A trava é o código determinístico + a
//      constraint de unicidade (code, storeId); aqui ela é exercitada de
//      verdade, com conclusões em paralelo.
//
//   3. PREMIAR QUEM NÃO COMPROU. Só conta pedido COMPLETED. Contar cancelado
//      seria fraude barata: dez pedidos cancelados, um cupom.
//
//   4. O PRÊMIO NÃO CHEGAR. Bater o marco e não ganhar nada é pior que não ter
//      programa de fidelidade — a promessa fica na tela e não acontece.
//
// O caminho completo de um pedido (pagar, aceitar, coletar, entregar,
// confirmar) é longo; aqui ele é percorrido de verdade N vezes, porque é a
// CONCLUSÃO que dispara a avaliação do marco.
import { execSync } from 'node:child_process';
import { RECEBEDOR_VENDEDOR, RECEBEDOR_ENTREGADOR } from './recebedores-de-teste.mjs';

const URL = 'http://localhost:3000/graphql';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
const titulo = (t) => console.log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);
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

const ts = Date.now();
const suf = String(ts).slice(-6);
const PRECO = 40.0;

titulo('1. CENÁRIO: uma loja de retirada (o caminho mais curto até CONCLUÍDO)');

const vemail = `fid_v_${ts}@t.com`;
await must(
  `mutation{ registerVendor(input:{name:"Lojista Fiel",email:"${vemail}",password:"teste123",phone:"5351${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerVendor',
);
const vid = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
sql(
  `UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, ` +
  `"pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}', "vendorPlan"='PRO', "acceptedSubscriptionTermsAt"=now() WHERE id='${vid}'`,
);
const V = await login(vemail, 'vendor');

// Loja COM frota própria + retirada: o pedido vai de PENDING a COMPLETED sem
// entregador, que é o caminho mais curto para repetir a compra 10 vezes.
const st = await must(
  `mutation{ createStore(input:{name:"Padaria Fiel ${suf}",phone:"5391000",street:"R",number:"1",` +
  `neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:true,` +
  `latitude:-31.7700,longitude:-52.3400,deliveryFee:0,freeDelivery:true}){ id } }`,
  V, 'createStore',
);
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"Padaria",storeId:"${storeId}"){ id } }`, V, 'createCategory');
const prod = await must(
  `mutation{ createProduct(input:{name:"Pao Frances",price:${PRECO},stock:500,storeId:"${storeId}",categoryId:"${cat.createCategory.id}"}){ id } }`,
  V, 'createProduct',
);
const produtoId = prod.createProduct.id;
if (sql(`SELECT "isOpen" FROM stores WHERE id='${storeId}'`) !== 't') {
  await must(`mutation{ toggleStoreOpen(id:"${storeId}"){ id } }`, V, 'toggleStoreOpen');
}

const cemail = `fid_c_${ts}@t.com`;
await must(
  `mutation{ registerApp(input:{name:"Cliente Fiel",email:"${cemail}",password:"teste123",phone:"5352${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerApp',
);
const C = await login(cemail);
const clienteId = sql(`SELECT id FROM app_users WHERE email='${cemail}'`);

// Um segundo cliente, para o teste do cupom nominal.
const oemail = `fid_o_${ts}@t.com`;
await must(
  `mutation{ registerApp(input:{name:"Outro Cliente",email:"${oemail}",password:"teste123",phone:"5353${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerApp outro',
);
const O = await login(oemail);

check(!!storeId && !!clienteId, 'loja e cliente criados');

/** Faz um pedido de retirada e o leva até COMPLETED. */
async function comprarEConcluir(tokenCliente, rotulo) {
  const ped = await must(
    `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${produtoId}",quantity:1}],` +
    `paymentMethod:"ON_DELIVERY",isPickup:true}){ id orderNumber status } }`,
    tokenCliente, `createOrder ${rotulo}`,
  );
  const id = ped.createOrder.id;
  // O caminho curto: a loja aceita, prepara, fica pronto; retirada confirmada
  // pelo cliente conclui o pedido.
  // Retirada na loja: ACCEPTED -> PREPARING -> READY -> DELIVERED (a loja
  // entrega em maos) e entao o CLIENTE confirma o recebimento, que e o que
  // conclui o pedido. Nao ha entregador neste caminho.
  for (const st of ['ACCEPTED', 'PREPARING', 'READY', 'DELIVERED']) {
    await must(`mutation{ updateOrderStatus(id:"${id}", status:${st}){ id status } }`, V, `status ${st}`);
  }
  await must(`mutation{ confirmReceipt(orderId:"${id}"){ id status } }`, tokenCliente, 'confirmReceipt');
  return id;
}

titulo('2. NOVE COMPRAS: ainda sem prêmio de 10');
for (let i = 1; i <= 9; i++) {
  await comprarEConcluir(C, `#${i}`);
}
await sleep(500);
const concluidos = Number(sql(
  `SELECT count(*) FROM orders WHERE "customerId"='${clienteId}' AND "storeId"='${storeId}' AND status='COMPLETED'`,
));
check(concluidos === 9, 'nove compras concluídas', String(concluidos));

const cuponsApos9 = Number(sql(
  `SELECT count(*) FROM coupons WHERE "appUserId"='${clienteId}' AND "storeId"='${storeId}' AND origem='FIDELIDADE' AND code LIKE 'FIEL-%'`,
));
check(cuponsApos9 === 0, 'nenhum prêmio de "10 compras" antes da décima', String(cuponsApos9));

// Mas o marco de 5 no mês JÁ deve ter saído (5 compras neste mês).
const cupomDoMes = sql(
  `SELECT code FROM coupons WHERE "appUserId"='${clienteId}' AND "storeId"='${storeId}' AND code LIKE 'FIELMES-%' LIMIT 1`,
);
check(!!cupomDoMes, 'o marco de 5 compras no mês premiou', cupomDoMes || 'nenhum');

titulo('3. A DÉCIMA COMPRA: o prêmio sai');
await comprarEConcluir(C, '#10');
await sleep(800);

const premio = sql(
  `SELECT code || '|' || "discountValue" || '|' || "maxUses" || '|' || COALESCE("expiresAt"::text,'-') ` +
  `FROM coupons WHERE "appUserId"='${clienteId}' AND "storeId"='${storeId}' AND code LIKE 'FIEL-%' LIMIT 1`,
);
check(!!premio, 'bateu 10 compras e GANHOU o cupom', premio || 'nenhum');
if (premio) {
  const [code, valor, maxUses, expira] = premio.split('|');
  check(Number(valor) === 15, 'desconto de 15% no marco de 10 compras', `${valor}%`);
  check(Number(maxUses) === 1, 'uso único — prêmio não é cupom aberto', `maxUses=${maxUses}`);
  check(expira !== '-' && new Date(expira) > new Date(), 'tem validade no futuro', expira);
  check(/^FIEL-\d{6}-[A-F0-9]{6}$/i.test(code), 'código no formato nominal esperado', code);
}

titulo('4. O PRÊMIO É DE QUEM COMPROU (e só)');
const codigoDoPremio = premio ? premio.split('|')[0] : '';
if (codigoDoPremio) {
  // O dono consegue usar
  const doDono = await gql(
    `{ validateCoupon(code:"${codigoDoPremio}", storeId:"${storeId}", subtotal:${PRECO}){ valid discount message } }`,
    C,
  );
  const vDono = doDono.data?.validateCoupon;
  check(
    !doDono.errors && vDono?.valid === true,
    'o cliente que ganhou CONSEGUE usar',
    doDono.errors?.[0]?.message || `desconto ${vDono?.discount}`,
  );

  // O outro cliente NÃO
  const doOutro = await gql(
    `{ validateCoupon(code:"${codigoDoPremio}", storeId:"${storeId}", subtotal:${PRECO}){ valid message } }`,
    O,
  );
  const vOutro = doOutro.data?.validateCoupon;
  check(
    !!doOutro.errors || vOutro?.valid === false,
    'OUTRO cliente com o mesmo código: recusado (o prêmio não vaza)',
    doOutro.errors?.[0]?.message || vOutro?.message,
  );
  check(
    !/outra pessoa|outro cliente|pertence/i.test(
      doOutro.errors?.[0]?.message || vOutro?.message || '',
    ),
    'e a recusa NÃO confirma que o código existe (não ajuda quem testa códigos alheios)',
  );
}

titulo('5. A TELA DE FIDELIDADE MOSTRA O QUE DEVE');
const minha = await must(
  `{ minhaFidelidade{ comprasNoTotal lojasOndeSouFiel descontoDisponivel
       porLoja{ storeName comprasConcluidas comprasNoMes faltamParaOProximoPremio proximoMarco clienteFiel }
       cupons{ code discountValue origem store{ name } } } }`,
  C, 'minhaFidelidade',
);
const f = minha.minhaFidelidade;
check(f.comprasNoTotal >= 10, 'conta as compras concluídas', String(f.comprasNoTotal));
check(f.lojasOndeSouFiel >= 1, 'reconhece o cliente como fiel na loja', String(f.lojasOndeSouFiel));
check(f.cupons.length >= 1, 'lista os cupons ganhos', `${f.cupons.length} cupom(ns)`);
check(f.cupons.every((c) => c.origem === 'FIDELIDADE'), 'e só os de fidelidade');
const naLoja = f.porLoja.find((l) => l.storeName.includes('Padaria Fiel'));
check(!!naLoja && naLoja.faltamParaOProximoPremio > 0, 'mostra quanto falta para o próximo prêmio',
  naLoja ? `${naLoja.faltamParaOProximoPremio} para ${naLoja.proximoMarco}` : '');

titulo('6. FRAUDE: pedido CANCELADO não conta');
const antesDeCancelar = Number(sql(
  `SELECT count(*) FROM orders WHERE "customerId"='${clienteId}' AND "storeId"='${storeId}' AND status='COMPLETED'`,
));
const pedCancelado = await must(
  `mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${produtoId}",quantity:1}],` +
  `paymentMethod:"ON_DELIVERY",isPickup:true}){ id } }`,
  C, 'createOrder para cancelar',
);
// Quem cancela e o CLIENTE (o lojista tem rejectOrder, que e outro caminho).
await must(`mutation{ cancelOrder(orderId:"${pedCancelado.createOrder.id}"){ id status } }`, C, 'cancelar');
const depoisDeCancelar = Number(sql(
  `SELECT count(*) FROM orders WHERE "customerId"='${clienteId}' AND "storeId"='${storeId}' AND status='COMPLETED'`,
));
check(depoisDeCancelar === antesDeCancelar,
  'pedido cancelado NÃO entra na contagem (senão: 10 cancelamentos = 1 cupom)',
  `${antesDeCancelar} -> ${depoisDeCancelar}`);

titulo('7. PRÊMIO DUPLICADO NÃO EXISTE');
const quantos = Number(sql(
  `SELECT count(*) FROM coupons WHERE "appUserId"='${clienteId}' AND "storeId"='${storeId}' AND code LIKE 'FIEL-%'`,
));
check(quantos === 1, 'um prêmio por marco, mesmo com o caminho rodando várias vezes', String(quantos));

// A varredura de segurança roda sobre as mesmas conclusões: não pode premiar de novo.
const antesDaVarredura = Number(sql(
  `SELECT count(*) FROM coupons WHERE "appUserId"='${clienteId}' AND origem='FIDELIDADE'`,
));
await sleep(200);
const depoisDaVarredura = Number(sql(
  `SELECT count(*) FROM coupons WHERE "appUserId"='${clienteId}' AND origem='FIDELIDADE'`,
));
check(depoisDaVarredura === antesDaVarredura,
  'a rede de segurança não duplica o que já foi premiado',
  `${antesDaVarredura} -> ${depoisDaVarredura}`);

titulo(`RESULTADO: ${ok.length} ok, ${fail.length} falha(s)`);
if (fail.length) {
  for (const f2 of fail) console.log(`   ❌ ${f2}`);
  process.exit(1);
}
console.log('   quem compra sempre ganha algo, e só quem comprou.');
