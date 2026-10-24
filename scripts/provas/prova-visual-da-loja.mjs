// ═══════════════════════════════════════════════════════════════════════════
// KAN-13 — A LOJA PINTA A PRÓPRIA VITRINE (sem poder torná-la ilegível)
// ═══════════════════════════════════════════════════════════════════════════
//
// O risco desta feature não é técnico, é de produto: dar o pincel ao lojista
// e deixar que ele torne a própria vitrine impossível de ler. Quem descobre
// isso é o CLIENTE, na hora de comprar, e ninguém fica sabendo.
//
// Então a prova cobre, nesta ordem:
//   1. a cor escolhida CHEGA ao cliente (sem isso a feature é decorativa);
//   2. texto e fundo sem contraste são RECUSADOS, com mensagem que explica;
//   3. dá para VOLTAR ao padrão (quem escolheu uma cor não fica preso a ela);
//   4. lixo não entra no banco (cor inventada, layout inventado);
//   5. quem não é da loja não muda a cara dela.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const APP = 'D:/linux/Documents/bcmTech/shopping-admin';
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

titulo('1. UMA LOJA E UM INTRUSO');
const email = `vis_v_${ts}@t.com`;
await must(
  `mutation{ registerVendor(input:{name:"Lojista Visual",email:"${email}",password:"teste123",phone:"5371${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerVendor',
);
const vid = sql(`SELECT id FROM vendor_users WHERE email='${email}'`);
sql(
  `UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, ` +
  `"pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}', "vendorPlan"='PRO', "acceptedSubscriptionTermsAt"=now() WHERE id='${vid}'`,
);
const V = await login(email);

const outroEmail = `vis_x_${ts}@t.com`;
await must(
  `mutation{ registerVendor(input:{name:"Intruso",email:"${outroEmail}",password:"teste123",phone:"5372${suf}",cpf:"${cpf()}"}){ accessToken } }`,
  null, 'registerVendor intruso',
);
const xid = sql(`SELECT id FROM vendor_users WHERE email='${outroEmail}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "acceptedSubscriptionTermsAt"=now() WHERE id='${xid}'`);
const X = await login(outroEmail);

const st = await must(
  `mutation{ createStore(input:{name:"Loja Visual ${suf}",phone:"5391000",street:"R",number:"1",` +
  `neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:true,` +
  `latitude:-31.77,longitude:-52.34}){ id slug } }`,
  V, 'createStore',
);
const storeId = st.createStore.id;
const slug = st.createStore.slug;
check(!!storeId, 'loja criada');

titulo('2. A COR ESCOLHIDA CHEGA AO CLIENTE');
const salvou = await gql(
  `mutation{ updateStore(input:{id:"${storeId}",primaryColor:"#1B5E20",backgroundColor:"#FFFDE7",textColor:"#212121",productLayout:"GRID"}){ ` +
  `id primaryColor backgroundColor textColor productLayout } }`,
  V,
);
check(!salvou.errors, 'a loja salva as cores', salvou.errors?.[0]?.message);
const s1 = salvou.data?.updateStore;
check(s1?.primaryColor === '#1B5E20' && s1?.productLayout === 'GRID',
  'e a mutation devolve o que foi salvo (senão o painel mostra o valor velho)',
  `${s1?.primaryColor} / ${s1?.productLayout}`);

// A vitrine PÚBLICA é a tela que o cliente abre — é lá que tem que chegar.
const vitrine = await must(
  `{ publicStorefront(slug:"${slug}"){ id primaryColor backgroundColor textColor productLayout } }`,
  null, 'publicStorefront',
);
const v = vitrine.publicStorefront;
check(v?.primaryColor === '#1B5E20', 'a vitrine pública devolve a cor principal', v?.primaryColor);
check(v?.backgroundColor === '#FFFDE7' && v?.textColor === '#212121',
  'e o fundo e o texto', `${v?.backgroundColor} / ${v?.textColor}`);
check(v?.productLayout === 'GRID', 'e o layout escolhido', v?.productLayout);

titulo('3. VITRINE ILEGÍVEL É RECUSADA');
const semContraste = await gql(
  `mutation{ updateStore(input:{id:"${storeId}",backgroundColor:"#FFFFFF",textColor:"#FAFAFA"}){ id } }`,
  V,
);
check(!!semContraste.errors, 'branco sobre branco: RECUSADO',
  semContraste.errors?.[0]?.message?.slice(0, 80));
check(
  /contraste|ler|escuro|claro/i.test(semContraste.errors?.[0]?.message || ''),
  'e a mensagem diz O QUE fazer, não só "inválido"',
);
const aindaLegivel = sql(`SELECT "textColor" FROM stores WHERE id='${storeId}'`);
check(aindaLegivel === '#212121', 'a loja continua com a cor anterior (nada foi salvo pela metade)', aindaLegivel);

// Contraste no limite: cinza médio sobre branco passa (é legível).
const noLimite = await gql(
  `mutation{ updateStore(input:{id:"${storeId}",backgroundColor:"#FFFFFF",textColor:"#767676"}){ id textColor } }`,
  V,
);
check(!noLimite.errors, 'cinza legível sobre branco: aceito', noLimite.errors?.[0]?.message?.slice(0, 60));

titulo('4. DÁ PARA VOLTAR AO PADRÃO');
const limpou = await gql(
  `mutation{ updateStore(input:{id:"${storeId}",primaryColor:"",backgroundColor:"",textColor:"",productLayout:""}){ ` +
  `id primaryColor backgroundColor textColor productLayout } }`,
  V,
);
check(!limpou.errors, 'string vazia é aceita', limpou.errors?.[0]?.message);
const s2 = limpou.data?.updateStore;
check(
  !s2?.primaryColor && !s2?.backgroundColor && !s2?.textColor && !s2?.productLayout,
  'e volta tudo ao tema da plataforma (quem escolheu uma cor não fica preso a ela)',
  JSON.stringify(s2),
);
const noBanco = sql(`SELECT COALESCE("primaryColor",'NULO') FROM stores WHERE id='${storeId}'`);
check(noBanco === 'NULO', 'no banco é NULL, não string vazia', noBanco);

titulo('5. LIXO NÃO ENTRA');
const corInvalida = await gql(
  `mutation{ updateStore(input:{id:"${storeId}",primaryColor:"vermelho"}){ id } }`,
  V,
);
check(!!corInvalida.errors, '"vermelho" não é cor hexadecimal: recusado',
  corInvalida.errors?.[0]?.message?.slice(0, 70));

const layoutInvalido = await gql(
  `mutation{ updateStore(input:{id:"${storeId}",productLayout:"CAROSSEL"}){ id } }`,
  V,
);
check(!!layoutInvalido.errors, 'layout inventado: recusado',
  layoutInvalido.errors?.[0]?.message?.slice(0, 70));

titulo('6. O APP REALMENTE USA O QUE FOI ESCOLHIDO');
// Estático, e de propósito: a tela é React Native e não há aparelho aqui. O
// que se confere é a FIAÇÃO — campo pedido na query, cores aplicadas no tema
// e o ramo de grade existindo. Salvar "GRID" e não desenhar grade nenhuma
// seria a mesma promessa vazia do KAN-252.
const telaDaLoja = readFileSync(`${APP}/app/store/[id].tsx`, 'utf8');
const queriesDoApp = readFileSync(`${APP}/src/lib/graphql/queries.ts`, 'utf8');
const selecaoStore = queriesDoApp.slice(
  queriesDoApp.indexOf('export const GET_STORE = gql'),
  queriesDoApp.indexOf('`;', queriesDoApp.indexOf('export const GET_STORE = gql')),
);
for (const campo of ['primaryColor', 'backgroundColor', 'textColor', 'productLayout']) {
  check(new RegExp(`^\\s*${campo}\\s*$`, 'm').test(selecaoStore), `o app PEDE ${campo} na query da loja`);
}
check(/aplicarCoresDaLoja\(coresDoApp, data\?\.store\)/.test(telaDaLoja),
  'a tela da loja aplica as cores por cima do tema do app');
check(/const ehGrade = store\?\.productLayout === 'GRID'/.test(telaDaLoja),
  'e decide o layout pelo que a loja escolheu');
check(/cartaoGrade/.test(telaDaLoja) && /imagemGrade/.test(telaDaLoja),
  'com um cartão próprio para a grade (foto grande, dois por linha)');

titulo('7. SÓ A LOJA MUDA A CARA DELA');
const intruso = await gql(
  `mutation{ updateStore(input:{id:"${storeId}",primaryColor:"#000000"}){ id } }`,
  X,
);
check(!!intruso.errors, 'outro lojista NÃO muda as cores da loja alheia',
  intruso.errors?.[0]?.message?.slice(0, 60));

titulo(`RESULTADO: ${ok.length} ok, ${fail.length} falha(s)`);
if (fail.length) {
  for (const f of fail) console.log(`   ❌ ${f}`);
  process.exit(1);
}
console.log('   a loja tem a cara dela, e continua legível.');
