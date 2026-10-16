// ═══════════════════════════════════════════════════════════════════════════
// KAN-82 — CONTAS DE EQUIPE: o funcionário entra só onde o dono deixou
// ═══════════════════════════════════════════════════════════════════════════
//
// Por que esta feature existe: hoje a loja tem UMA conta. Na prática o dono
// passa a senha dele para o atendente que despacha pedidos — e com ela vão os
// recebimentos, os dados bancários e o poder de apagar a loja.
//
// A mudança tocou as 31 checagens de "é o dono?" espalhadas pelo backend. Essa
// é a parte perigosa: afrouxar uma delas por engano abre IDOR entre lojas, que
// é pior do que o problema original. Então a prova verifica, nesta ordem:
//
//   1. o DONO continua podendo tudo (não quebrei o que funcionava);
//   2. o FUNCIONÁRIO faz o que foi liberado;
//   3. o FUNCIONÁRIO é barrado no que NÃO foi liberado;
//   4. um lojista QUALQUER continua sem acesso nenhum à loja alheia — a
//      regressão que transformaria a feature num buraco;
//   5. convite: aceitar com outro e-mail não funciona, token não se reusa,
//      revogado perde o acesso na hora.
import { execSync } from 'node:child_process';
import { RECEBEDOR_VENDEDOR } from './recebedores-de-teste.mjs';

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
async function login(email, kind = 'vendor') {
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

/** Cria um lojista aprovado e devolve { email, id, token }. */
async function criarLojista(prefixo, telefone) {
  const email = `${prefixo}_${ts}@t.com`;
  await must(
    `mutation{ registerVendor(input:{name:"${prefixo}",email:"${email}",password:"teste123",phone:"${telefone}",cpf:"${cpf()}"}){ accessToken } }`,
    null, `registerVendor ${prefixo}`,
  );
  const id = sql(`SELECT id FROM vendor_users WHERE email='${email}'`);
  sql(
    `UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, ` +
    `"pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}', "vendorPlan"='PRO', "acceptedSubscriptionTermsAt"=now() WHERE id='${id}'`,
  );
  return { email, id, token: await login(email) };
}

titulo('1. UMA LOJA, TRÊS PESSOAS');
const dono = await criarLojista('eq_dono', `5361${suf}`);
const func = await criarLojista('eq_func', `5362${suf}`);
const estranho = await criarLojista('eq_estranho', `5363${suf}`);

const st = await must(
  `mutation{ createStore(input:{name:"Loja Equipe ${suf}",phone:"5391000",street:"R",number:"1",` +
  `neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:true,` +
  `latitude:-31.77,longitude:-52.34}){ id } }`,
  dono.token, 'createStore',
);
const storeId = st.createStore.id;
const cat = await must(`mutation{ createCategory(name:"Geral",storeId:"${storeId}"){ id } }`, dono.token, 'createCategory');
const catId = cat.createCategory.id;
check(!!storeId, 'loja criada pelo dono');

titulo('2. O DONO CONTINUA PODENDO TUDO');
const prodDoDono = await gql(
  `mutation{ createProduct(input:{name:"Produto do Dono",price:10,stock:5,storeId:"${storeId}",categoryId:"${catId}"}){ id } }`,
  dono.token,
);
check(!prodDoDono.errors, 'dono cria produto', prodDoDono.errors?.[0]?.message);
const cupomDoDono = await gql(
  `mutation{ createCoupon(input:{code:"DONO${suf}",discountType:"PERCENT",discountValue:10,storeId:"${storeId}"}){ id } }`,
  dono.token,
);
check(!cupomDoDono.errors, 'dono cria cupom', cupomDoDono.errors?.[0]?.message);

titulo('3. ESTRANHO NÃO ENTRA (a regressão que importa)');
const prodEstranho = await gql(
  `mutation{ createProduct(input:{name:"Invasao",price:10,stock:5,storeId:"${storeId}",categoryId:"${catId}"}){ id } }`,
  estranho.token,
);
check(!!prodEstranho.errors, 'lojista de fora NÃO cria produto na loja alheia',
  prodEstranho.errors?.[0]?.message?.slice(0, 60));
const equipeEstranho = await gql(`{ equipeDaLoja(storeId:"${storeId}"){ id } }`, estranho.token);
check(!!equipeEstranho.errors, 'e não enxerga a equipe da loja alheia',
  equipeEstranho.errors?.[0]?.message?.slice(0, 60));

titulo('4. CONVITE');
const convite = await gql(
  `mutation{ convidarMembro(storeId:"${storeId}", email:"${func.email}", role:EMPLOYEE, permissions:[PRODUCTS]){ id memberEmail role permissions acceptedAt } }`,
  dono.token,
);
check(!convite.errors, 'dono convida o funcionário só para PRODUTOS',
  convite.errors?.[0]?.message || convite.data?.convidarMembro?.permissions?.join(','));
const membroId = convite.data?.convidarMembro?.id;
check(convite.data?.convidarMembro?.acceptedAt == null, 'o convite nasce PENDENTE (ninguém entra sem aceitar)');

// Antes de aceitar, o funcionário não tem nada.
const antesDeAceitar = await gql(
  `mutation{ createProduct(input:{name:"Antes",price:10,stock:5,storeId:"${storeId}",categoryId:"${catId}"}){ id } }`,
  func.token,
);
check(!!antesDeAceitar.errors, 'convite pendente NÃO dá acesso',
  antesDeAceitar.errors?.[0]?.message?.slice(0, 50));

// O token do convite não volta pelo GraphQL (é segredo); para o teste, leio o
// hash no banco não serve — então uso um token conhecido: regravo o hash.
const tokenDeTeste = `tok${ts}`;
const hash = execSync(
  `node -e "console.log(require('crypto').createHash('sha256').update('${tokenDeTeste}').digest('hex'))"`,
  { encoding: 'utf8' },
).trim();
sql(`UPDATE vendor_team_members SET "inviteTokenHash"='${hash}' WHERE id='${membroId}'`);

// Aceitar com a conta ERRADA tem que falhar.
const aceiteErrado = await gql(`mutation{ aceitarConviteDeEquipe(token:"${tokenDeTeste}"){ id } }`, estranho.token);
check(!!aceiteErrado.errors, 'aceitar com OUTRA conta é recusado (link vazado não vira acesso)',
  aceiteErrado.errors?.[0]?.message?.slice(0, 60));

const aceite = await gql(`mutation{ aceitarConviteDeEquipe(token:"${tokenDeTeste}"){ id acceptedAt } }`, func.token);
check(!aceite.errors && !!aceite.data?.aceitarConviteDeEquipe?.acceptedAt,
  'o convidado aceita com a própria conta', aceite.errors?.[0]?.message);

const reuso = await gql(`mutation{ aceitarConviteDeEquipe(token:"${tokenDeTeste}"){ id } }`, func.token);
check(!!reuso.errors, 'o token é de uso único — não serve duas vezes',
  reuso.errors?.[0]?.message?.slice(0, 50));

titulo('5. O FUNCIONÁRIO FAZ O QUE FOI LIBERADO');
const prodDoFunc = await gql(
  `mutation{ createProduct(input:{name:"Produto do Funcionario",price:12,stock:5,storeId:"${storeId}",categoryId:"${catId}"}){ id name } }`,
  func.token,
);
check(!prodDoFunc.errors, 'funcionário com PRODUCTS CRIA produto na loja',
  prodDoFunc.errors?.[0]?.message || prodDoFunc.data?.createProduct?.name);

titulo('6. E É BARRADO NO QUE NÃO FOI');
const cupomDoFunc = await gql(
  `mutation{ createCoupon(input:{code:"FUNC${suf}",discountType:"PERCENT",discountValue:50,storeId:"${storeId}"}){ id } }`,
  func.token,
);
check(!!cupomDoFunc.errors, 'sem COUPONS: não cria cupom (ele daria 50% de desconto na loja do patrão)',
  cupomDoFunc.errors?.[0]?.message?.slice(0, 60));

const equipeDoFunc = await gql(`{ equipeDaLoja(storeId:"${storeId}"){ id } }`, func.token);
check(!!equipeDoFunc.errors, 'EMPLOYEE não gerencia a equipe (não se auto-promove)',
  equipeDoFunc.errors?.[0]?.message?.slice(0, 60));

const conviteDoFunc = await gql(
  `mutation{ convidarMembro(storeId:"${storeId}", email:"amigo_${ts}@t.com", role:MANAGER, permissions:[PRODUCTS,COUPONS,EARNINGS]){ id } }`,
  func.token,
);
check(!!conviteDoFunc.errors, 'e não convida ninguém — nem com permissões maiores que as dele',
  conviteDoFunc.errors?.[0]?.message?.slice(0, 60));

titulo('7. O DONO MUDA AS PERMISSÕES, E ISSO VALE NA HORA');
const atualiza = await gql(
  `mutation{ atualizarMembroDaEquipe(membroId:"${membroId}", permissions:[PRODUCTS,COUPONS], role:EMPLOYEE){ id permissions } }`,
  dono.token,
);
check(!atualiza.errors, 'dono adiciona COUPONS ao funcionário',
  atualiza.errors?.[0]?.message || atualiza.data?.atualizarMembroDaEquipe?.permissions?.join(','));

const cupomAgora = await gql(
  `mutation{ createCoupon(input:{code:"FUNC2${suf}",discountType:"PERCENT",discountValue:5,storeId:"${storeId}"}){ id code } }`,
  func.token,
);
check(!cupomAgora.errors, 'agora o funcionário cria cupom', cupomAgora.errors?.[0]?.message);

titulo('8. REVOGAR TIRA O ACESSO NA HORA');
const revoga = await gql(`mutation{ revogarMembroDaEquipe(membroId:"${membroId}") }`, dono.token);
check(!revoga.errors && revoga.data?.revogarMembroDaEquipe === true, 'dono revoga o acesso',
  revoga.errors?.[0]?.message);

const depoisDeRevogar = await gql(
  `mutation{ createProduct(input:{name:"Depois de revogado",price:9,stock:1,storeId:"${storeId}",categoryId:"${catId}"}){ id } }`,
  func.token,
);
check(!!depoisDeRevogar.errors, 'ex-funcionário NÃO cria mais nada (sem precisar deslogar)',
  depoisDeRevogar.errors?.[0]?.message?.slice(0, 50));

const historico = sql(
  `SELECT count(*) FROM vendor_team_members WHERE "storeId"='${storeId}' AND "revokedAt" IS NOT NULL`,
);
check(Number(historico) === 1, 'o vínculo revogado FICA no histórico (auditoria), não é apagado', historico);

titulo(`RESULTADO: ${ok.length} ok, ${fail.length} falha(s)`);
if (fail.length) {
  for (const f of fail) console.log(`   ❌ ${f}`);
  process.exit(1);
}
console.log('   o funcionário tem a conta dele, com a chave da porta certa.');
