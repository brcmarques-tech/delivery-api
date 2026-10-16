// ═══════════════════════════════════════════════════════════════════════════
// KAN-248 — A SESSÃO DO CLIENTE SAI DO ALCANCE DO JAVASCRIPT
// ═══════════════════════════════════════════════════════════════════════════
//
// O problema: o accessToken do cliente (validade 7 dias) ficava no
// `localStorage` do site. Qualquer script que rodasse na página — um pacote de
// terceiro comprometido, uma extensão, um `dangerouslySetInnerHTML` futuro —
// lia `localStorage.token` e saía com a sessão do cliente, podendo fazer
// pedidos no nome dele.
//
// A correção: o navegador passou a falar com /api/graphql (proxy do próprio
// site), que guarda o token num cookie httpOnly e o ARRANCA da resposta do
// login. Quem adiciona o `Authorization` é o servidor do Next.
//
// Esta prova checa as três coisas que podem dar errado sem ninguém notar:
//   1. o token ainda aparecer para o JavaScript (em cookie legível, no corpo
//      da resposta ou de volta no localStorage);
//   2. o cookie funcionar (sem isso, TODA operação autenticada do site quebra
//      — era o risco maior desta mudança);
//   3. o proxy continuar sendo um proxy fiel para query pública, erro de
//      GraphQL e sessão expirada.
//
// PRECISA: a API em localhost:3000 e o site rodando (SITE_URL, por padrão
// localhost:3005 — `npx next dev -p 3005` no shopping-storefront).
import { readFileSync } from 'node:fs';

const SITE = process.env.SITE_URL || 'http://localhost:3005';
const PROXY = `${SITE}/api/graphql`;
const RAIZ_SITE = 'D:/linux/Documents/bcmTech/shopping-storefront';

const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
const titulo = (t) => console.log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cpf() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const d = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * (a.length + 1 - i); const r = 11 - (s % 11); return r >= 10 ? 0 : r; };
  const d1 = d(n), d2 = d([...n, d1]);
  return [...n, d1, d2].join('');
}

/** Fala com o proxy exatamente como o Apollo do navegador faria. */
async function viaProxy(query, variables, cookie) {
  const r = await fetch(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  // getSetCookie mantém os cookies separados (o join por vírgula quebra a data
  // do Expires e faz o parse achar que é um cookie só).
  const setCookies = r.headers.getSetCookie?.() || [];
  return { status: r.status, corpo: await r.json(), setCookies };
}
const valorDoCookie = (setCookies, nome) => {
  const linha = setCookies.find((c) => c.startsWith(`${nome}=`));
  return linha ? { linha, valor: linha.slice(nome.length + 1).split(';')[0] } : null;
};

const ts = Date.now();
const email = `sess_${ts}@t.com`;
const senha = 'teste123';

// ════════════════════════════════════════════════ 0. o site está no ar?
const vivo = await fetch(SITE).then((r) => r.ok).catch(() => false);
if (!vivo) {
  console.error(`O site não respondeu em ${SITE}. Suba com "npx next dev -p 3005" no shopping-storefront (ou defina SITE_URL).`);
  process.exit(2);
}

// ════════════════════════════════════════════════ 1. CADASTRO PELO PROXY
titulo('1. O CADASTRO VOLTA SEM O TOKEN');

const reg = await viaProxy(
  `mutation Reg($input: RegisterAppInput!){ registerApp(input:$input){ accessToken user{ id name email } } }`,
  { input: { name: 'Cliente Sessao', email, password: senha, phone: `5344${String(ts).slice(-6)}`, cpf: cpf() } },
);
check(!reg.corpo.errors, 'cadastro aceito pelo proxy', reg.corpo.errors?.[0]?.message?.slice(0, 80));
const tokenNoCorpo = reg.corpo.data?.registerApp?.accessToken;
check(tokenNoCorpo === '', 'o accessToken volta VAZIO para o navegador (arrancado pelo proxy)',
  tokenNoCorpo ? `veio ${String(tokenNoCorpo).slice(0, 12)}…` : 'vazio');
check(!!reg.corpo.data?.registerApp?.user?.id, 'mas os dados do cliente continuam vindo (a tela precisa do nome)');

const sessaoReg = valorDoCookie(reg.setCookies, 'bcm_sess');
check(!!sessaoReg, 'o proxy gravou o cookie de sessão');
check(!!sessaoReg && /httponly/i.test(sessaoReg.linha), 'o cookie é HttpOnly — JavaScript não o lê',
  sessaoReg?.linha.replace(sessaoReg.valor, '<token>').slice(0, 90));
check(!!sessaoReg && /samesite=lax/i.test(sessaoReg.linha), 'com SameSite=Lax (não viaja em requisição de outro site)');

// ════════════════════════════════════════════════ 2. LOGIN E USO DA SESSÃO
titulo('2. A SESSÃO FUNCIONA — e isso é o que mais importa');

await sleep(300);
const login = await viaProxy(
  `mutation L($input: LoginInput!){ loginApp(input:$input, forceLogin:true){ accessToken user{ id } } }`,
  { input: { email, password: senha } },
);
check(!login.corpo.errors, 'login aceito pelo proxy', login.corpo.errors?.[0]?.message?.slice(0, 80));
check(login.corpo.data?.loginApp?.accessToken === '', 'login também não devolve token ao navegador');

const sess = valorDoCookie(login.setCookies, 'bcm_sess');
const logado = valorDoCookie(login.setCookies, 'bcm_logado');
check(!!sess, 'cookie de sessão renovado no login');
check(!!logado && logado.valor === '1', 'e o cookie LEGÍVEL de "tem sessão" foi gravado');
check(!!logado && !/httponly/i.test(logado.linha),
  'esse é legível de propósito (a tela decide se abre o login antes do checkout)');
check(!!logado && !logado.valor.includes('.'),
  'e NÃO carrega o token (um JWT tem pontos; este vale "1")', logado?.valor);

const cookie = `bcm_sess=${sess.valor}`;
const meus = await viaProxy(`{ myOrders(limit:1){ id orderNumber } }`, {}, cookie);
check(!meus.corpo.errors, 'com o cookie, uma query AUTENTICADA passa (o proxy injeta o Authorization)',
  meus.corpo.errors?.[0]?.message?.slice(0, 80));
check(Array.isArray(meus.corpo.data?.myOrders), 'e devolve dados do próprio cliente');

const semCookie = await viaProxy(`{ myOrders(limit:1){ id } }`, {});
check(!!semCookie.corpo.errors, 'sem o cookie, a mesma query é recusada (não há sessão implícita)',
  semCookie.corpo.errors?.[0]?.message?.slice(0, 60));

// ════════════════════════════════════════════════ 3. PROXY FIEL
titulo('3. O PROXY NÃO ATRAPALHA O RESTO');

const publica = await viaProxy(`{ publicStores{ id name } }`, {});
check(!publica.corpo.errors && Array.isArray(publica.corpo.data?.publicStores),
  'query pública funciona sem cookie nenhum (a vitrine não exige login)');

const errado = await viaProxy(`{ naoExisteEssaQuery }`, {});
check(!!errado.corpo.errors?.[0]?.message,
  'erro de GraphQL chega inteiro no cliente (o proxy não engole a mensagem)',
  errado.corpo.errors?.[0]?.message?.slice(0, 60));

// Sessão inválida: o proxy tem que APAGAR os dois cookies, senão a tela segue
// se achando logada para sempre (o bug do KAN-257, agora do lado do cookie).
const invalido = await viaProxy(`{ myOrders(limit:1){ id } }`, {}, 'bcm_sess=nao.e.um.token.valido');
check(!!invalido.corpo.errors, 'token inválido é recusado');
const limpouSess = invalido.setCookies.some((c) => /^bcm_sess=;|^bcm_sess=\s*;/.test(c) || /^bcm_sess=;?\s*Max-Age=0/i.test(c) || (c.startsWith('bcm_sess=') && /max-age=0|expires=thu, 01 jan 1970/i.test(c)));
const limpouFlag = invalido.setCookies.some((c) => c.startsWith('bcm_logado=') && /max-age=0|expires=thu, 01 jan 1970/i.test(c));
check(limpouSess && limpouFlag, 'e os DOIS cookies são apagados na mesma resposta',
  invalido.setCookies.join(' | ').slice(0, 120));

// ════════════════════════════════════════════════ 4. NADA DE TOKEN NO CÓDIGO
titulo('4. O CÓDIGO DO SITE NÃO GUARDA MAIS TOKEN');

const arquivos = ['lib/apollo.ts', 'components/AuthModal.tsx', 'components/StorefrontClient.tsx'];
for (const f of arquivos) {
  const src = readFileSync(`${RAIZ_SITE}/${f}`, 'utf8');
  check(!/localStorage\.(get|set)Item\(\s*['"]token['"]/.test(src), `${f} não toca em localStorage.token`);
}
const apollo = readFileSync(`${RAIZ_SITE}/lib/apollo.ts`, 'utf8');
check(/uri:\s*'\/api\/graphql'/.test(apollo), 'o Apollo do navegador aponta para o proxy do site');
check(/credentials:\s*'same-origin'/.test(apollo),
  "e manda o cookie junto (sem `credentials` o proxy recebe a chamada sem sessão)");
const sessao = readFileSync(`${RAIZ_SITE}/lib/sessao.ts`, 'utf8');
check(/bcm_logado/.test(sessao) && !/bcm_sess/.test(sessao),
  'o helper da tela só conhece o cookie legível — nem o nome do cookie da sessão');

// ════════════════════════════════════════════════ FIM
titulo(`RESULTADO: ${ok.length} ok, ${fail.length} falha(s)`);
if (fail.length) {
  for (const f of fail) console.log(`   ❌ ${f}`);
  process.exit(1);
}
console.log('   o token do cliente não passa mais pelo JavaScript.');
