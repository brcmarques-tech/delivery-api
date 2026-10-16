// O QUE O PROVEDOR DEVOLVE NUM *VOID* DE PRE-AUTORIZACAO?
//
// Em 15/10/2026 eu provei que `DELETE /charges/{id}` numa cobranca PAGA pode
// responder HTTP 200 com o estorno RECUSADO, e que a verdade esta em
// `last_transaction.status` ∈ {refunded, partial_refunded}. O helper
// `estornarCobranca` decide por isso.
//
// Mas o codigo usa a MESMA rota para outra coisa: anular uma pre-autorizacao
// que nunca foi capturada (payments.service.ts, `cancelPreAuth` e o ramo
// `authorized` do caminho de estorno). Ali ninguem olha o resultado. Antes de
// mandar esses dois pontos pelo helper eu preciso saber se a palavra da verdade
// e a mesma — num void nao houve captura, logo "refunded" pode nao aparecer, e
// nesse caso o helper reprovaria um void BEM-SUCEDIDO.
//
// Por que importa: se o void falha em silencio, o pedido vira CANCELLED e o
// LIMITE DO CARTAO DO CLIENTE FICA PRESO ate a pre-auth caducar (dias). E o
// cliente nao tem a quem recorrer: para a plataforma, deu tudo certo.
//
// ATENCAO: cria cobrancas reais no sandbox (R$ 2 a R$ 3) e as anula aqui mesmo.
import fs from 'fs';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// scripts/provas/<este arquivo> -> a raiz da API e dois niveis acima.
const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');


const env = fs.readFileSync(path.join(RAIZ_API, '.env'), 'utf8');
const g = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const KEY = g('PAGARME_SECRET_KEY');
if (!KEY || !KEY.startsWith('sk_test')) {
  console.error('ABORTADO: chave nao e de sandbox. Este script cria cobrancas.');
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(KEY + ':').toString('base64');
const BASE = 'https://api.pagar.me/core/v5';

async function req(metodo, path, corpo) {
  const r = await fetch(BASE + path, {
    method: metodo,
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  return { http: r.status, j, vazio: t === '', bruto: t };
}

// Mesmo corpo que o codigo monta em criarPreAuth (operation_type pre_auth).
async function novaPreAuth(valorCents, rotulo) {
  const r = await req('POST', '/orders', {
    closed: true,
    customer: {
      name: 'Teste Void', email: 'teste.void@bcmtech.local', type: 'individual',
      document: '02518896023',
      phones: { mobile_phone: { country_code: '55', area_code: '53', number: '999999999' } },
    },
    items: [{ amount: valorCents, description: rotulo, quantity: 1, code: 'exp-void' }],
    payments: [{
      payment_method: 'credit_card',
      credit_card: {
        operation_type: 'pre_auth',
        installments: 1, statement_descriptor: 'BCMTESTE',
        card: {
          number: '4000000000000010', holder_name: 'TESTE VOID',
          exp_month: 12, exp_year: 30, cvv: '123',
          billing_address: { line_1: 'Rua Teste, 1', zip_code: '96000000', city: 'Pelotas', state: 'RS', country: 'BR' },
        },
      },
    }],
  });
  if (!r.j?.charges?.[0]) console.error('  corpo da falha:', r.http, JSON.stringify(r.j).slice(0, 400));
  return r.j?.charges?.[0] || null;
}

function resumo(j) {
  const lt = j?.last_transaction || {};
  const erro = lt.gateway_response?.errors?.[0]?.message;
  return `charge=${j?.status} amount=${j?.amount} | last_tx.status=${lt.status ?? '-'}` +
    ` last_tx.amount=${lt.amount ?? '-'}` +
    (lt.acquirer_message ? ` | "${lt.acquirer_message}"` : '') +
    (erro ? ` | erro="${erro}"` : '');
}

// ───────────────────────────────────────────────────── 1. como nasce a pre-auth
console.log('=== 1. uma pre-autorizacao recem-criada ===');
const c1 = await novaPreAuth(200, 'void: pre-auth virgem');
if (!c1) { console.error('nao consegui criar a pre-auth'); process.exit(1); }
console.log(`  cobranca ${c1.id}`);
console.log(`  ${resumo(c1)}`);
console.log(`  >>> status de nascimento: "${c1.status}" (o codigo espera authorized|pending_capture|pending)`);

// ───────────────────────────────────────────────────── 2. o void
console.log('\n=== 2. DELETE /charges/{id} numa pre-auth NAO capturada ===');
const v = await req('DELETE', `/charges/${c1.id}`);
console.log(`  HTTP ${v.http}`);
console.log(`  ${resumo(v.j)}`);
const ltVoid = String(v.j?.last_transaction?.status ?? '-');
const chVoid = String(v.j?.status ?? '-');
console.log(`\n  >>> charge.status      = "${chVoid}"`);
console.log(`  >>> last_transaction   = "${ltVoid}"`);
console.log(
  `  >>> o helper estornarCobranca aceita {refunded, partial_refunded}: ` +
    (['refunded', 'partial_refunded'].includes(ltVoid.toLowerCase())
      ? 'PASSARIA — da para reusar o helper como esta'
      : `REPROVARIA um void bem-sucedido (recebeu "${ltVoid}") — o helper precisa aceitar a palavra do void`),
);

// ───────────────────────────────────────────────────── 3. void repetido
console.log('\n=== 3. void de novo na MESMA cobranca (idempotencia) ===');
const v2 = await req('DELETE', `/charges/${c1.id}`);
console.log(`  HTTP ${v2.http}`);
if (v2.j) console.log(`  ${resumo(v2.j)}`);
else console.log(`  corpo: ${v2.vazio ? '(vazio)' : v2.bruto.slice(0, 300)}`);
console.log(
  `  >>> ${v2.http >= 400
    ? 'ERRO — o segundo void falha; quem re-tenta precisa tolerar isso'
    : 'HTTP 2xx — repetir o void nao explode'}`,
);

// ───────────────────────────────────────────── 4. captura depois do void
console.log('\n=== 4. tentar CAPTURAR uma cobranca ja anulada ===');
const cap = await req('POST', `/charges/${c1.id}/capture`, { amount: 200 });
console.log(`  HTTP ${cap.http}`);
if (cap.j) console.log(`  ${resumo(cap.j)}`);
else console.log(`  corpo: ${cap.vazio ? '(vazio)' : cap.bruto.slice(0, 300)}`);
console.log(
  `  >>> ${cap.http >= 400
    ? 'ERRO HTTP — captura invalida vira excecao, o try/catch pega'
    : 'HTTP 2xx!! captura invalida NAO lanca — quem nao olha o resultado marca como capturado'}`,
);

// ───────────────────────────────────── 5. captura legitima: o 200 garante algo?
console.log('\n=== 5. captura LEGITIMA de outra pre-auth: o que vem no 200 ===');
const c2 = await novaPreAuth(300, 'void: captura legitima');
if (c2) {
  console.log(`  cobranca ${c2.id} nasceu "${c2.status}"`);
  const ok = await req('POST', `/charges/${c2.id}/capture`, { amount: 300 });
  console.log(`  HTTP ${ok.http}`);
  console.log(`  ${resumo(ok.j)}`);
  console.log(`  >>> result.status = "${ok.j?.status}" | last_tx = "${ok.j?.last_transaction?.status}"`);

  // captura em DOBRO da mesma cobranca — o codigo do agendamento nao olharia
  const dobro = await req('POST', `/charges/${c2.id}/capture`, { amount: 300 });
  console.log(`\n  captura REPETIDA da mesma cobranca: HTTP ${dobro.http}`);
  if (dobro.j) console.log(`  ${resumo(dobro.j)}`);
  console.log(
    `  >>> ${dobro.http >= 400
      ? 'ERRO HTTP — recaptura lanca excecao'
      : 'HTTP 2xx — recaptura passa calada; so o status do corpo denuncia'}`,
  );

  // limpa: estorna a capturada para nao deixar saldo preso no sandbox
  await req('DELETE', `/charges/${c2.id}`);
}

console.log('\n--- fim. nenhuma conclusao aqui e deducao: tudo veio da resposta do provedor ---');
