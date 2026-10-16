// PROVA REPRODUZIVEL dos dois bugs de estorno (KAN-301), consolidada dos tres
// experimentos que fiz em 15/10/2026.
//
// ATENCAO: este script CRIA cobrancas reais no sandbox (cartao de teste do
// provedor, valores de R$ 2 a R$ 4) e as estorna no proprio script. Nao e para
// rodar por habito — e a evidencia de como o provedor se comporta, para quem
// precisar confirmar ou revisitar a decisao.
//
// O que ele demonstra:
//   1. POST /charges/{id}/refund NAO EXISTE (404 corpo vazio), mesmo numa
//      cobranca real e paga — enquanto /capture no mesmo id casa a rota.
//   2. DELETE /charges/{id} sem corpo = estorno TOTAL.
//   3. DELETE /charges/{id} com { amount } = estorno PARCIAL, e a cobranca
//      CONTINUA "paid" (correto: so parte voltou).
//   4. O provedor responde HTTP 200 MESMO QUANDO O ESTORNO FALHA. O resultado
//      real esta em last_transaction.status. Ha uma janela de ~10s apos a
//      captura em que ele recusa com "action_forbidden | Valor invalido para
//      estorno." — devolvendo 200.
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

const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? 'OK  ' : 'FALHOU'} ${n}${d ? ' — ' + d : ''}`); };

async function req(metodo, path, corpo) {
  const r = await fetch(BASE + path, {
    method: metodo,
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  return { status: r.status, j, vazio: t === '', bruto: t };
}

async function novaCobranca(valorCents, rotulo) {
  const r = await req('POST', '/orders', {
    closed: true,
    customer: {
      name: 'Teste Estorno', email: 'teste.estorno@bcmtech.local', type: 'individual',
      document: '02518896023',
      phones: { mobile_phone: { country_code: '55', area_code: '53', number: '999999999' } },
    },
    items: [{ amount: valorCents, description: rotulo, quantity: 1, code: 'exp-refund' }],
    payments: [{
      payment_method: 'credit_card',
      credit_card: {
        installments: 1, statement_descriptor: 'BCMTESTE',
        card: {
          number: '4000000000000010', holder_name: 'TESTE ESTORNO',
          exp_month: 12, exp_year: 30, cvv: '123',
          billing_address: { line_1: 'Rua Teste, 1', zip_code: '96000000', city: 'Pelotas', state: 'RS', country: 'BR' },
        },
      },
    }],
  });
  return r.j?.charges?.[0] || null;
}

function resumo(j) {
  const lt = j?.last_transaction || {};
  const erro = lt.gateway_response?.errors?.[0]?.message;
  return `charge=${j?.status} amount=${j?.amount} | last_tx=${lt.status ?? '-'} amount=${lt.amount ?? '-'}` +
    (erro ? ` | "${erro}"` : '') + (lt.acquirer_message ? ` | "${lt.acquirer_message}"` : '');
}

const esperar = (s) => new Promise((r) => setTimeout(r, s * 1000));

// ─────────────────────────────────────────────────────────── 1
console.log('=== 1. a rota que o codigo usava, numa cobranca REAL e PAGA ===');
const c1 = await novaCobranca(200, 'prova: rota de estorno');
if (!c1) { console.error('nao consegui criar cobranca'); process.exit(1); }
console.log(`  cobranca: ${c1.id} status=${c1.status} amount=${c1.amount}`);
check(['paid', 'captured'].includes(String(c1.status).toLowerCase()), 'a cobranca esta capturada', c1.status);

const viaRefund = await req('POST', `/charges/${c1.id}/refund`, { amount: 100 });
const controle = await req('POST', `/charges/${c1.id}/capture`, { amount: 100 });
check(
  viaRefund.status === 404 && viaRefund.vazio,
  'POST /charges/{id}/refund -> 404 com CORPO VAZIO (rota inexistente)',
  `status=${viaRefund.status}${viaRefund.vazio ? ' vazio' : ''}`,
);
check(
  !controle.vazio,
  'controle: /capture no MESMO id responde com mensagem (rota existe)',
  (controle.j?.message || controle.bruto).slice(0, 70),
);

const depois404 = await req('GET', `/charges/${c1.id}`);
check(String(depois404.j?.status).toLowerCase() === 'paid', 'o 404 nao mexeu na cobranca', resumo(depois404.j));

// ─────────────────────────────────────────────────────────── 2
console.log('\n=== 2. a janela de ~10s: o 200 que MENTE ===');
const imediato = await req('DELETE', `/charges/${c1.id}`);
console.log(`  DELETE imediato -> HTTP ${imediato.status} | ${resumo(imediato.j)}`);
const falhouMas200 =
  imediato.status === 200 && String(imediato.j?.last_transaction?.status).toLowerCase() === 'failed';
check(
  falhouMas200 || String(imediato.j?.status).toLowerCase() === 'canceled',
  falhouMas200
    ? 'HTTP 200 com last_transaction.status=failed — o 200 NAO garante estorno'
    : 'estorno passou de primeira (a janela ja havia fechado)',
  `last_tx=${imediato.j?.last_transaction?.status}`,
);

if (falhouMas200) {
  console.log('  aguardando 12s para a janela fechar...');
  await esperar(12);
  const depois = await req('DELETE', `/charges/${c1.id}`);
  console.log(`  DELETE depois da espera -> HTTP ${depois.status} | ${resumo(depois.j)}`);
  check(
    ['canceled', 'refunded'].includes(String(depois.j?.status).toLowerCase()),
    'o MESMO pedido passa a funcionar depois da janela — era tempo, nao forma',
    depois.j?.status,
  );
}

// ─────────────────────────────────────────────────────────── 3
console.log('\n=== 3. estorno PARCIAL com { amount } ===');
const c2 = await novaCobranca(300, 'prova: estorno parcial');
if (c2) {
  console.log(`  cobranca: ${c2.id} amount=${c2.amount}`);
  console.log('  aguardando 12s (a janela de recusa pos-captura)...');
  await esperar(12);
  const parcial = await req('DELETE', `/charges/${c2.id}`, { amount: 100 });
  console.log(`  DELETE { amount: 100 } de 300 -> HTTP ${parcial.status} | ${resumo(parcial.j)}`);
  const lt = String(parcial.j?.last_transaction?.status).toLowerCase();
  check(lt === 'partial_refunded', 'last_transaction.status = partial_refunded', lt);
  check(
    String(parcial.j?.status).toLowerCase() === 'paid',
    'a cobranca CONTINUA "paid" no parcial — isso e SUCESSO, nao falha',
    parcial.j?.status,
  );
  // limpa o resto
  const resto = await req('DELETE', `/charges/${c2.id}`);
  console.log(`  (limpando o restante: HTTP ${resto.status} status=${resto.j?.status})`);
}

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((x) => console.log(' - ' + x)); process.exit(1); }
