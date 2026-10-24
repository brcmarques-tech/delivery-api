// Valida o conserto da antecipacao contra o Pagar.me sandbox.
//
// A rota de SIMULACAO (/bulk_anticipations/simulate) NAO e barrada pelo
// allowlist de IP, entao da para provar o contrato de verdade. A rota de
// CRIACAO (/bulk_anticipations) e barrada — o teste confirma que o erro mudou de
// "404 rota inexistente" para "401 IP nao autorizado", que e o bloqueio real e
// acionavel.
import fs from 'fs';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// scripts/provas/<este arquivo> -> a raiz da API e dois niveis acima.
const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');


const env = fs.readFileSync(path.join(RAIZ_API, '.env'), 'utf8');
const g = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const KEY = g('PAGARME_SECRET_KEY');
const PLAT = g('PAGARME_PLATFORM_RECIPIENT_ID');
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
  let j; try { j = JSON.parse(t); } catch { j = { bruto: t }; }
  return { status: r.status, msg: j.message || '', corpo: j, vazio: t === '' };
}

// Reproduz o helper dataDeAntecipacao do service, para testar a MESMA regra.
function dataDeAntecipacao(agora = new Date()) {
  const TZ = 'America/Sao_Paulo';
  const hoje = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora);
  const [hh, mm] = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(agora).split(':').map(Number);
  const [ano, mes, dia] = hoje.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (hh * 60 + mm >= 11 * 60) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

console.log('=== 1. a rota ANTIGA (v4) realmente nao existe ===');
const antiga = await req('POST', `/recipients/${PLAT}/anticipations`, {});
const inventada = await req('POST', `/recipients/${PLAT}/rota_inventada_xyz`, {});
check(
  antiga.status === 404 && antiga.vazio && inventada.status === 404 && inventada.vazio,
  '/anticipations responde igual a uma rota inventada (404 corpo vazio)',
  `antiga=${antiga.status}${antiga.vazio ? ' vazio' : ''} | inventada=${inventada.status}${inventada.vazio ? ' vazio' : ''}`,
);

console.log('\n=== 2. a rota de SIMULACAO da v5 existe e valida os campos ===');
const vazio = await req('POST', `/recipients/${PLAT}/bulk_anticipations/simulate`, {});
check(vazio.status === 400, 'corpo vazio devolve 400 (rota existe, nao e 404 nem 401)', `status=${vazio.status}`);
check(/valor est[aá] faltando/i.test(vazio.msg), 'o erro lista o campo de valor como obrigatorio');
check(/D\+0 at[eé] 11AM ou D\+1/i.test(vazio.msg), 'o erro confirma a regra D+0 ate 11AM ou D+1');
check(/'start', 'end'/.test(vazio.msg), "o erro confirma os valores 'start' e 'end'");

console.log('\n=== 3. os nomes de campo que o codigo usa sao os certos ===');
const comAmount = await req('POST', `/recipients/${PLAT}/bulk_anticipations/simulate`, { amount: 1000, payment_date: '2020-01-01', timeframe: 'xxx' });
check(/valor est[aá] faltando/i.test(comAmount.msg), '"amount" NAO e aceito como valor (reclamacao continua)');
const comRequested = await req('POST', `/recipients/${PLAT}/bulk_anticipations/simulate`, { requested_amount: 1000, payment_date: '2020-01-01', timeframe: 'xxx' });
check(!/valor est[aá] faltando/i.test(comRequested.msg), '"requested_amount" E aceito (reclamacao de valor sai)');
const comType = await req('POST', `/recipients/${PLAT}/bulk_anticipations/simulate`, { requested_amount: 1000, payment_date: '2020-01-01', type: 'start' });
check(/tipo de antecipa/i.test(comType.msg), '"type" NAO e aceito como tipo (reclamacao continua)');
const comTimeframe = await req('POST', `/recipients/${PLAT}/bulk_anticipations/simulate`, { requested_amount: 1000, payment_date: '2020-01-01', timeframe: 'start' });
check(!/tipo de antecipa/i.test(comTimeframe.msg), '"timeframe" E aceito (reclamacao de tipo sai)');

console.log('\n=== 4. o corpo EXATO que o codigo passa a enviar e aceito na validacao ===');
const dataCalc = dataDeAntecipacao();
const agora = new Date();
console.log(`    agora: ${agora.toISOString()} UTC | ${agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} Sao Paulo`);
console.log(`    payment_date calculado pela regra: ${dataCalc}`);
const corpoReal = { payment_date: dataCalc, timeframe: 'start', requested_amount: 1000 };
const real = await req('POST', `/recipients/${PLAT}/bulk_anticipations/simulate`, corpoReal);
console.log(`    resposta: ${real.status} ${real.msg || JSON.stringify(real.corpo).slice(0, 200)}`);
check(
  !/data de pagamento inv[aá]lida/i.test(real.msg),
  'a data calculada pela regra do negocio NAO e recusada pelo provedor',
  real.msg ? real.msg.slice(0, 120) : 'sem erro',
);
check(
  !/valor est[aá] faltando|tipo de antecipa/i.test(real.msg),
  'nenhum campo obrigatorio faltando no corpo que o codigo envia',
);

console.log('\n=== 5. a data ANTIGA (UTC, sem a regra das 11h) seria recusada? ===');
// Como era antes: new Date() -> toISOString(), so desviando de sabado/domingo em UTC
const antigaData = (() => {
  const t = new Date();
  const d = t.getDay();
  if (d === 0) t.setDate(t.getDate() + 1);
  if (d === 6) t.setDate(t.getDate() + 2);
  return t.toISOString().split('T')[0];
})();
console.log(`    data pelo calculo ANTIGO: ${antigaData} | pelo NOVO: ${dataCalc}`);
if (antigaData === dataCalc) {
  console.log('    (neste instante as duas coincidem — a divergencia aparece depois das 11h de Sao Paulo)');
} else {
  const comAntiga = await req('POST', `/recipients/${PLAT}/bulk_anticipations/simulate`, { payment_date: antigaData, timeframe: 'start', requested_amount: 1000 });
  console.log(`    com a data antiga: ${comAntiga.status} ${comAntiga.msg.slice(0, 140)}`);
  check(/data de pagamento inv[aá]lida/i.test(comAntiga.msg), 'a data do calculo ANTIGO e recusada pelo provedor');
}

console.log('\n=== 6. a regra das 11h, simulada em varios horarios ===');
const horarios = [
  ['seg 09:00 BRT', '2026-10-19T12:00:00Z', '2026-10-19'],
  ['seg 10:59 BRT', '2026-10-19T13:59:00Z', '2026-10-19'],
  ['seg 11:00 BRT', '2026-10-19T14:00:00Z', '2026-10-20'],
  ['seg 14:00 BRT', '2026-10-19T17:00:00Z', '2026-10-20'],
  ['seg 22:00 BRT', '2026-10-20T01:00:00Z', '2026-10-20'],
  ['sex 14:00 BRT', '2026-10-23T17:00:00Z', '2026-10-26'],
  ['sab 09:00 BRT', '2026-10-24T12:00:00Z', '2026-10-26'],
  ['dom 09:00 BRT', '2026-10-25T12:00:00Z', '2026-10-26'],
];
let erros = 0;
for (const [rotulo, instante, esperado] of horarios) {
  const got = dataDeAntecipacao(new Date(instante));
  const bate = got === esperado;
  if (!bate) erros++;
  console.log(`    ${bate ? 'ok ' : 'ERR'} ${rotulo.padEnd(14)} -> ${got} (esperado ${esperado})`);
}
check(erros === 0, 'a regra D+0 ate 11h / proximo dia util bate em 8 horarios', `${erros} divergencias`);

console.log('\n=== 7. a rota de CRIACAO: o erro mudou de 404 para o bloqueio real ===');
const criacao = await req('POST', `/recipients/${PLAT}/bulk_anticipations`, {});
check(criacao.status === 401, 'criacao devolve 401 (allowlist de IP), nao mais 404 silencioso', `${criacao.status} ${criacao.msg}`);

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((x) => console.log(' - ' + x)); process.exit(1); }
