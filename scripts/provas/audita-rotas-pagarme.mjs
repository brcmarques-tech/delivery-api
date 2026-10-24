// Audita TODOS os caminhos do Pagar.me que o codigo usa, de uma vez.
//
// Tecnica: usar um id de recurso INEXISTENTE. Assim nada pode ser criado,
// alterado ou apagado, e a resposta ainda distingue os dois casos:
//
//   rota EXISTE  + recurso inexistente -> 404 COM mensagem ("could not be found")
//                                         ou 400/401/422 (validacao / allowlist)
//   rota NAO EXISTE                    -> 404 com CORPO VAZIO
//
// O discriminador foi validado antes: /recipients/{falso}/balance devolve
// 404 {"message":"The recipient could not be found"} enquanto uma rota inventada
// devolve 404 vazio.
import fs from 'fs';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// scripts/provas/<este arquivo> -> a raiz da API e dois niveis acima.
const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');


const env = fs.readFileSync(path.join(RAIZ_API, '.env'), 'utf8');
const g = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const KEY = g('PAGARME_SECRET_KEY');
const auth = 'Basic ' + Buffer.from(KEY + ':').toString('base64');
const BASE = 'https://api.pagar.me/core/v5';

const FALSO_REC = 're_naoexisteisso000000000000';
const FALSO_CH = 'ch_naoexisteisso000000000000';
const FALSO_OR = 'or_naoexisteisso000000000000';
const FALSO_SUB = 'sub_naoexisteisso00000000000';

async function req(metodo, path, corpo) {
  try {
    const r = await fetch(BASE + path, {
      method: metodo,
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
    });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = null; }
    return { status: r.status, msg: j?.message || '', vazio: t === '', bruto: t };
  } catch (e) {
    return { status: 0, msg: 'erro de rede: ' + e.message, vazio: false, bruto: '' };
  }
}

// controle: shape de rota inexistente, em cada verbo
console.log('=== CONTROLE: rotas inventadas (o shape de "rota nao existe") ===');
const controles = {};
for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) {
  const r = await req(m, `/recipients/${FALSO_REC}/rota_inventada_xyz`, m === 'GET' || m === 'DELETE' ? undefined : {});
  controles[m] = r;
  console.log(`  ${m.padEnd(7)} -> ${r.status} ${r.vazio ? '(CORPO VAZIO)' : r.msg || r.bruto.slice(0, 60)}`);
}
console.log('');

const ROTAS = [
  // [verbo, caminho, rotulo, onde no codigo]
  ['GET', `/recipients/${FALSO_REC}`, 'recebedor por id', 'getRecipientBalance, 3486'],
  ['GET', `/recipients/${FALSO_REC}/balance`, 'saldo do recebedor', 'getRecipientBalance, 3485'],
  ['GET', '/recipients?code=vendor_zzz_inexistente', 'busca recebedor por code', 'ensureVendorRecipient, 2167'],
  ['GET', `/orders/${FALSO_OR}`, 'pedido por id', 'varios: 1526, 2424, 3320'],
  ['GET', `/charges/${FALSO_CH}`, 'cobranca por id', 'varios: 2422, 2683, 3332'],
  ['GET', `/subscriptions/${FALSO_SUB}`, 'assinatura por id', 'checkSubscription, 2032'],
  ['DELETE', `/charges/${FALSO_CH}`, 'cancelar pre-autorizacao', 'cancelPreAuth, 1130'],
  ['POST', `/charges/${FALSO_CH}/refund`, 'estorno de cobranca', 'refundOrder, 3345'],
  ['POST', `/charges/${FALSO_CH}/capture`, 'captura com split', 'captureWithSplit, 1114'],
  ['DELETE', `/subscriptions/${FALSO_SUB}`, 'cancelar assinatura', '1919, 1988'],
  ['PATCH', `/subscriptions/${FALSO_SUB}`, 'alterar assinatura', 'changePlan, 2009'],
  // a que me deixou desconfiado: caminho com HIFEN, incomum na v5
  ['PATCH', `/recipients/${FALSO_REC}/automatic-anticipation-settings`, 'auto-antecipacao (HIFEN, como no codigo)', 'updateRecipientAnticipationSettings, 3681'],
  ['PATCH', `/recipients/${FALSO_REC}/automatic_anticipation_settings`, 'auto-antecipacao (UNDERSCORE)', '(variante a testar)'],
  // antecipacao, para registro
  ['POST', `/recipients/${FALSO_REC}/bulk_anticipations`, 'criar antecipacao (v5)', 'requestAnticipation, 3645'],
  ['POST', `/recipients/${FALSO_REC}/bulk_anticipations/simulate`, 'simular antecipacao (v5)', 'simulateAnticipation, 3568'],
  ['POST', `/recipients/${FALSO_REC}/anticipations`, 'antecipacao (caminho v4, removido)', '(nao usado mais)'],
];

console.log('=== CAMINHOS QUE O CODIGO USA ===\n');
const suspeitos = [];
for (const [metodo, path, rotulo, onde] of ROTAS) {
  const corpo = metodo === 'GET' || metodo === 'DELETE' ? undefined : {};
  const r = await req(metodo, path, corpo);
  const comoControle = r.status === controles[metodo].status && r.vazio && controles[metodo].vazio;
  const marca = comoControle ? '!! SUSPEITO' : 'ok        ';
  if (comoControle) suspeitos.push({ rotulo, metodo, path, onde });
  console.log(`  ${marca} ${String(r.status).padEnd(4)} ${metodo.padEnd(7)} ${rotulo}`);
  console.log(`              ${r.vazio ? '(CORPO VAZIO — shape de rota inexistente)' : (r.msg || r.bruto.slice(0, 110))}`);
  console.log(`              codigo: ${onde}`);
}

console.log('\n\n=== CONCLUSAO ===');
if (suspeitos.length === 0) {
  console.log('  Nenhum caminho responde como rota inexistente. Todos existem.');
} else {
  console.log(`  ${suspeitos.length} caminho(s) respondem IGUAL a uma rota inventada:`);
  for (const s of suspeitos) {
    console.log(`   - ${s.metodo} ${s.path}`);
    console.log(`     usado em: ${s.onde}  (${s.rotulo})`);
  }
  console.log('\n  "Rota inexistente" aqui significa: ou o caminho esta errado, ou');
  console.log('  nao existe nesse VERBO. Conferir antes de concluir.');
}
