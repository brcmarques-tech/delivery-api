// ═══════════════════════════════════════════════════════════════════════════
// KAN-143 — LIMPEZA DOS DADOS DE TESTE ANTES DO PRIMEIRO CLIENTE REAL
// ═══════════════════════════════════════════════════════════════════════════
//
// Para que serve: apagar o que as validações de pagamento, os E2E e as demos
// deixaram no banco, para o primeiro lojista real não entrar num ambiente com
// 328 pedidos de teste, 158 lojas fantasma e repasses de sandbox misturados
// aos dele.
//
// COMO ELE DECIDE O QUE APAGAR
//
// Não por heurística de e-mail. Padrão de e-mail erra para os dois lados: um
// cliente real com "teste" no endereço seria apagado, e um dado de teste com
// e-mail de aparência real sobreviveria. Então:
//
//   TRANSACIONAL (pedido, entrega, pagamento, agendamento, log, carrinho,
//   avaliação, assinatura, webhook): apaga TUDO. Antes do lançamento não
//   existe transação real para preservar — e é justamente esse o momento de
//   rodar isto.
//
//   CONTAS E CATÁLOGO (usuários, lojas, produtos, categorias, serviços,
//   cupons, promoções): apaga tudo que NÃO estiver na lista de preservação.
//   A lista é explícita: superadmins, os e-mails em MANTER e qualquer um
//   passado em --manter=a@x.com,b@y.com.
//
//   CONFIGURAÇÃO (platform_config, site_config, pagarme_plans, migrations):
//   não toca. É configuração da plataforma, não dado de teste.
//
// SEGURANÇA
//
//   - sem --executar, é DRY-RUN: só mostra o que faria;
//   - roda tudo numa transação: ou limpa inteiro, ou não mexe em nada;
//   - se o banco não for local, exige --producao-confirmada (é o único caso em
//     que um erro meu é irreversível, e um flag a mais é barato);
//   - imprime o alvo (host/base) antes de qualquer coisa, porque "apaguei no
//     banco errado" é o pior final possível para um script assim.
//
// SOBRE "resetar a sequência de orderNumber" (está no ticket): não existe
// sequência. O número é `ORD-<epoch ms>-<3 bytes aleatórios>` — não há
// contador para zerar, e por isso nada a fazer. Fica registrado aqui para o
// item não voltar a ser procurado.
//
// USO
//   node scripts/limpa-dados-de-teste.mjs                 # dry-run
//   node scripts/limpa-dados-de-teste.mjs --executar
//   node scripts/limpa-dados-de-teste.mjs --executar --manter=dono@loja.com
import 'dotenv/config';
import pg from 'pg';

const args = process.argv.slice(2);
const EXECUTAR = args.includes('--executar');
const PROD_OK = args.includes('--producao-confirmada');
const MANTER_CLI = (args.find((a) => a.startsWith('--manter=')) || '').replace('--manter=', '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Contas que NUNCA são apagadas, além de todo superadmin. */
const MANTER = [
  'admin@bcmtech.com.br',
  'superadmin@bcmtech.com.br',
  'bcmtechdev@gmail.com',
  ...MANTER_CLI,
];

// Tabelas 100% transacionais: tudo sai.
//
// A ORDEM É PARTE DA CORREÇÃO. A primeira versão apagava `appointments` antes
// de `service_ratings`, e o Postgres recusou: a avaliação referencia o
// agendamento. A transação inteira voltou atrás (o rollback funcionou, o que é
// a parte boa da história), mas um script que precisa de três tentativas para
// rodar não serve para a véspera de um lançamento.
//
// Então a lista está em ordem de dependência, FILHO antes de PAI, conferida
// contra o grafo real de FKs do banco (information_schema), não de memória:
//
//   order_status_logs, order_items, deliveries -> orders
//   service_ratings -> appointments, services
//   appointments -> services, stores, app_users
//   orders -> stores, coupons, app_users
//
// O que sobra (payments, saved_cards, subscriptions, webhook_events, logs,
// store_follows, addresses) só aponta para usuário/loja, e esses são apagados
// depois, no bloco de contas.
const TRANSACIONAL = [
  'order_status_logs',
  'order_items',
  'deliveries',
  'orders',
  'service_ratings',
  'appointments',
  'schedules',
  'cart_items',
  'payments',
  'saved_cards',
  'subscriptions',
  'webhook_events',
  'notification_logs',
  'approval_log',
  'agent_sessions',
  'store_follows',
  'addresses',
];

// Catálogo/contas: sai o que não é preservado (a condição é montada abaixo).
// Catálogo, também em ordem de dependência: promotions e products antes de
// categories (products -> categories), e services antes de categories pelo
// mesmo motivo.
const dependeDeLoja = ['promotions', 'products', 'services', 'coupons', 'categories'];

const conexao = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USERNAME || 'shopping',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE || 'shopping_db',
    };

const ehLocal = /localhost|127\.0\.0\.1/.test(
  conexao.connectionString || String(conexao.host),
);

const cliente = new pg.Client(conexao);
await cliente.connect();

const alvo = (await cliente.query(
  'SELECT current_database() AS base, inet_server_addr()::text AS host',
)).rows[0];

console.log('═'.repeat(70));
console.log(`ALVO: base "${alvo.base}" em ${alvo.host || conexao.host || 'socket'}`);
console.log(`MODO: ${EXECUTAR ? 'EXECUTAR (apaga de verdade)' : 'DRY-RUN (não apaga nada)'}`);
console.log(`PRESERVA: superadmins + ${MANTER.join(', ')}`);
console.log('═'.repeat(70));

if (EXECUTAR && !ehLocal && !PROD_OK) {
  console.error(
    '\nO banco NÃO é local e --producao-confirmada não foi passado. Parando.\n' +
      'Isto existe para que um comando copiado e colado não apague produção por engano.',
  );
  await cliente.end();
  process.exit(2);
}

const contar = async (tabela, onde = '') => {
  const { rows } = await cliente.query(`SELECT count(*)::int AS n FROM "${tabela}" ${onde}`);
  return rows[0].n;
};

// ── quem fica ──────────────────────────────────────────────────────────────
const listaManter = MANTER.map((e) => `'${e.replace(/'/g, "''")}'`).join(',');
const VENDOR_FICA = `(lower(email) IN (${listaManter}) OR role = 'SUPERADMIN')`;
// SUPERADMIN tambem existe em app_users — e e justamente a conta que os E2E e
// o painel usam (superadmin@bcmtech.com). A primeira versao desta lista so
// olhava e-mail, e teria apagado o superadmin do app: o proprio dono da
// limpeza perderia o acesso logo depois de rodar.
const APP_FICA = `(lower(email) IN (${listaManter}) OR role = 'SUPERADMIN')`;

const vendorFicam = await contar('vendor_users', `WHERE ${VENDOR_FICA}`);
const appFicam = await contar('app_users', `WHERE ${APP_FICA}`);
const lojasFicam = await contar(
  'stores',
  `WHERE "ownerId" IN (SELECT id FROM vendor_users WHERE ${VENDOR_FICA})`,
);

console.log('\nO QUE FICA');
console.log(`   vendor_users ... ${vendorFicam}`);
console.log(`   app_users ...... ${appFicam}`);
console.log(`   stores ......... ${lojasFicam} (das contas preservadas)`);
if (vendorFicam === 0 && appFicam === 0) {
  console.log('\n   Atenção: nenhuma conta preservada casou. Confira --manter antes de executar.');
}

console.log('\nO QUE SAI');
const plano = [];
for (const t of TRANSACIONAL) {
  const n = await contar(t);
  if (n > 0) plano.push({ sql: `DELETE FROM "${t}"`, rotulo: t, n });
}
for (const t of dependeDeLoja) {
  const onde = `WHERE "storeId" NOT IN (SELECT id FROM stores WHERE "ownerId" IN (SELECT id FROM vendor_users WHERE ${VENDOR_FICA})) OR "storeId" IS NULL`;
  const n = await contar(t, onde);
  if (n > 0) plano.push({ sql: `DELETE FROM "${t}" ${onde}`, rotulo: t, n });
}
{
  const onde = `WHERE "ownerId" NOT IN (SELECT id FROM vendor_users WHERE ${VENDOR_FICA}) OR "ownerId" IS NULL`;
  const n = await contar('stores', onde);
  if (n > 0) plano.push({ sql: `DELETE FROM "stores" ${onde}`, rotulo: 'stores', n });
}
{
  const onde = `WHERE NOT ${VENDOR_FICA}`;
  const n = await contar('vendor_users', onde);
  if (n > 0) plano.push({ sql: `DELETE FROM "vendor_users" ${onde}`, rotulo: 'vendor_users', n });
}
{
  const onde = `WHERE NOT ${APP_FICA}`;
  const n = await contar('app_users', onde);
  if (n > 0) plano.push({ sql: `DELETE FROM "app_users" ${onde}`, rotulo: 'app_users', n });
}

if (plano.length === 0) {
  console.log('   (nada a apagar — o banco já está limpo)');
} else {
  for (const p of plano) console.log(`   ${p.rotulo.padEnd(20)} ${String(p.n).padStart(6)} linha(s)`);
}

if (!EXECUTAR) {
  console.log('\nDRY-RUN: nada foi apagado. Para aplicar, repita com --executar.');
  await cliente.end();
  process.exit(0);
}

// ── executa ────────────────────────────────────────────────────────────────
console.log('\nAPLICANDO...');
try {
  await cliente.query('BEGIN');
  for (const p of plano) {
    const r = await cliente.query(p.sql);
    console.log(`   ${p.rotulo.padEnd(20)} ${String(r.rowCount).padStart(6)} apagada(s)`);
  }
  await cliente.query('COMMIT');
  console.log('\nOK — limpeza aplicada numa única transação.');
} catch (err) {
  await cliente.query('ROLLBACK');
  console.error('\nFALHOU, e NADA foi apagado (rollback):', err.message);
  await cliente.end();
  process.exit(1);
}

const sobrou = {};
for (const t of ['orders', 'deliveries', 'payments', 'stores', 'products', 'app_users', 'vendor_users']) {
  sobrou[t] = await contar(t);
}
console.log('\nCOMO O BANCO FICOU');
for (const [t, n] of Object.entries(sobrou)) console.log(`   ${t.padEnd(20)} ${String(n).padStart(6)}`);

await cliente.end();
