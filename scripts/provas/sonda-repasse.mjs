// Descobre QUAIS mecanismos de movimentacao de dinheiro existem na v5, para
// decidir como automatizar o repasse ao entregador no PIX.
//
// A pergunta central: existe transferencia PLATAFORMA -> RECEBEDOR?
//   - Se SIM, o repasse automatico e simples: o PIX fica 100% na plataforma e
//     depois a plataforma paga vendedor e entregador.
//   - Se NAO, o unico mecanismo e o SPLIT, e o split precisa conhecer o
//     entregador no momento da cobranca — o que hoje nao acontece.
//
// Tudo com ids INEXISTENTES: nada pode ser movido.
import fs from 'fs';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// scripts/provas/<este arquivo> -> a raiz da API e dois niveis acima.
const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');


const env = fs.readFileSync(path.join(RAIZ_API, '.env'), 'utf8');
const g = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const KEY = g('PAGARME_SECRET_KEY');
const PLAT = g('PAGARME_PLATFORM_RECIPIENT_ID');
if (!KEY.startsWith('sk_test')) { console.error('so em sandbox'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(KEY + ':').toString('base64');
const BASE = 'https://api.pagar.me/core/v5';
const FALSO = 're_naoexisteisso000000000000';

async function req(metodo, path, corpo) {
  const r = await fetch(BASE + path, {
    method: metodo,
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  return { status: r.status, msg: j?.message || '', erros: j?.errors, vazio: t === '', bruto: t };
}

function diag(r) {
  if (r.vazio && r.status === 404) return 'NAO EXISTE (404 vazio)';
  if (r.status === 405) return 'rota existe, VERBO nao aceito';
  if (r.status === 401) return 'EXISTE, barrada por allowlist de IP';
  if (r.erros) return 'EXISTE -> validacao: ' + JSON.stringify(r.erros).slice(0, 200);
  return `EXISTE -> ${r.msg || r.bruto.slice(0, 120)}`;
}

function mostra(rotulo, r) {
  console.log(`  ${String(r.status).padEnd(4)} ${rotulo.padEnd(48)} ${diag(r)}`);
}

console.log('=== 1. TRANSFERENCIAS (o mecanismo que o codigo tentou usar) ===');
mostra('POST /transfers', await req('POST', '/transfers', {}));
mostra('GET  /transfers', await req('GET', '/transfers'));
mostra('POST /recipients/{falso}/transfers', await req('POST', `/recipients/${FALSO}/transfers`, {}));
mostra('GET  /recipients/{falso}/transfers', await req('GET', `/recipients/${FALSO}/transfers`));
mostra('GET  /recipients/{plat}/transfers', await req('GET', `/recipients/${PLAT}/transfers`));

console.log('\n=== 2. outros nomes possiveis para pagamento/saque ===');
mostra('POST /payouts', await req('POST', '/payouts', {}));
mostra('POST /withdrawals', await req('POST', '/withdrawals', {}));
mostra('POST /recipients/{falso}/withdrawals', await req('POST', `/recipients/${FALSO}/withdrawals`, {}));
mostra('GET  /balance_operations', await req('GET', '/balance_operations'));
mostra('GET  /recipients/{plat}/balance/operations', await req('GET', `/recipients/${PLAT}/balance/operations`));

console.log('\n=== 3. SPLIT depois do fato: da para editar o split de uma cobranca? ===');
mostra('GET  /charges/{falso}/split', await req('GET', '/charges/ch_naoexiste000000000000/split'));
mostra('PATCH /charges/{falso}/split', await req('PATCH', '/charges/ch_naoexiste000000000000/split', {}));
mostra('POST /charges/{falso}/split', await req('POST', '/charges/ch_naoexiste000000000000/split', {}));
mostra('PATCH /orders/{falso}/split', await req('PATCH', '/orders/or_naoexiste000000000000/split', {}));

console.log('\n=== 4. o split aceita recebedor com valor ZERO? ===');
console.log('    (se aceitar, da para reservar a vaga do entregador na cobranca');
console.log('     e preencher depois — se houver como editar)');
const comZero = await req('POST', '/orders', {
  closed: true,
  customer: { name: 'T', email: 't@t.local', type: 'individual', document: '02518896023',
    phones: { mobile_phone: { country_code: '55', area_code: '53', number: '999999999' } } },
  items: [{ amount: 1000, description: 'teste split zero', quantity: 1, code: 'x' }],
  payments: [{ payment_method: 'pix', pix: { expires_in: 3600 },
    split: [
      { amount: 1000, recipient_id: PLAT, type: 'flat',
        options: { charge_processing_fee: true, liable: true, charge_remainder_fee: true } },
      { amount: 0, recipient_id: FALSO, type: 'flat',
        options: { charge_processing_fee: false, liable: false, charge_remainder_fee: false } },
    ] }],
});
console.log(`  ${comZero.status} split com uma regra de valor 0: ${comZero.msg || JSON.stringify(comZero.erros || '').slice(0, 200) || 'aceito'}`);

console.log('\n\n=== CONCLUSAO A LER ===');
console.log('  Se /transfers existir e aceitar um destino, o repasse automatico e direto.');
console.log('  Se so existir saque do proprio saldo, o entregador tem de estar no SPLIT —');
console.log('  e aí o problema passa a ser QUANDO o split e definido.');
