// ═══════════════════════════════════════════════════════════════════════════
// KAN-283 — AS MIGRATIONS CONSTROEM O BANCO DE PRODUCAO A PARTIR DO ZERO?
// ═══════════════════════════════════════════════════════════════════════════
//
// O achado: nenhuma das 27 tabelas tinha CREATE TABLE em migration. O schema
// de producao so existia porque o `synchronize` o criou antes de ser desligado
// (KAN-214). Entao `migration:run` num banco vazio falhava na primeira
// migration, e producao era irreconstituivel por codigo — dependia do snapshot
// do Lightsail. Snapshot nao e schema versionado: nao se revisa, nao se
// compara, e nao se sabe o que tem dentro.
//
// Esta prova nao le arquivo nem compara texto. Ela RODA:
//
//   1. cria um banco VAZIO
//   2. roda `migration:run` nele (as 14 migrations, baseline primeiro)
//   3. roda `migration:run` DE NOVO — tem que ser no-op (o boot de producao
//      roda migrations a cada deploy; uma que estoura na segunda vez derruba
//      a API)
//   4. compara o schema resultante, COLUNA POR COLUNA de todas as tabelas,
//      com o que o `synchronize` produz a partir das entidades
//   5. prova que a baseline e no-op num banco que JA tem o schema (o caso do
//      snapshot de producao)
//   6. prova a deduplicacao de cupom: com duplicata na base, o boot aborta se
//      a migration nao renomear antes de criar o indice unico
//
// O passo 4 e o que importa: schema "que sobe" nao e schema "igual ao de
// producao". Sem comparar, a baseline poderia criar 27 tabelas parecidas e o
// deploy quebrar num tipo de coluna.
//
// NAO TOCA no shopping_db. Os bancos descartaveis sao apagados no fim.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DO_ZERO = 'ensaio_baseline';
const DE_ENTIDADES = 'ensaio_sync';
const CUPOM = 'ensaio_cupom';

const ok = [], falhas = [];
const check = (c, n, d = '') => { (c ? ok : falhas).push(n); console.log(`${c ? 'OK  ' : 'FALHOU'} ${n}${d ? ' — ' + d : ''}`); };
const titulo = (t) => console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);

const psql = (cmd, db = 'postgres') =>
  execSync(`docker exec shopping-postgres psql -U shopping -d ${db} -tAc "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

// Só o VALOR de um RETURNING (ver o comentário no uso).
const primeiraLinha = (saida) => String(saida || '').split('\n')[0].trim();
const envDe = (db) => ({
  ...process.env,
  DATABASE_URL: '',
  DB_HOST: 'localhost', DB_PORT: '5432', DB_USERNAME: 'shopping', DB_DATABASE: db,
});
function npmNo(db, comando) {
  try {
    return { ok: true, saida: execSync(`npm run ${comando}`, { cwd: RAIZ_API, encoding: 'utf8', env: envDe(db), stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, saida: (e.stdout || '') + (e.stderr || '') };
  }
}

// Assinatura do schema INTEIRO: tabela, coluna, tipo, tamanho, precisao,
// nullability e default. É o que um deploy quebra quando divergir.
const assinatura = (db) =>
  psql(
    `SELECT table_name || '.' || column_name || ' | ' || data_type || ' | len=' || coalesce(character_maximum_length::text,'-') ` +
    `|| ' | prec=' || coalesce(numeric_precision::text,'-') || ',' || coalesce(numeric_scale::text,'-') ` +
    `|| ' | null=' || is_nullable || ' | default=' || coalesce(column_default,'-') ` +
    `FROM information_schema.columns WHERE table_schema='public' AND table_name <> 'migrations' ` +
    `ORDER BY table_name, column_name`,
    db,
  );

let criados = [];
function criar(db) {
  psql(`DROP DATABASE IF EXISTS ${db}`);
  psql(`CREATE DATABASE ${db} OWNER shopping`);
  criados.push(db);
}

try {
  // ═══════════════════════════ 1. do zero, pelas migrations
  titulo('1. BANCO VAZIO + migration:run');
  criar(DO_ZERO);
  check(
    Number(psql(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`, DO_ZERO)) === 0,
    'o banco começa realmente vazio',
  );

  const run1 = npmNo(DO_ZERO, 'migration:run');
  check(run1.ok, 'migration:run sobe o schema do zero',
    run1.ok ? '' : run1.saida.split('\n').filter((l) => /error|Error/.test(l))[0]?.slice(0, 140));
  if (!run1.ok) throw new Error('sem schema do zero, o resto da prova não tem sentido');

  const tabelas = Number(psql(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'migrations'`, DO_ZERO));
  check(tabelas >= 27, 'as tabelas foram criadas', `${tabelas} tabelas`);
  const aplicadas = Number(psql('SELECT count(*) FROM migrations', DO_ZERO));
  check(aplicadas >= 14, 'todas as migrations ficaram registradas', `${aplicadas} registradas`);
  const primeira = psql('SELECT name FROM migrations ORDER BY timestamp LIMIT 1', DO_ZERO);
  check(/Baseline/.test(primeira), 'a baseline rodou PRIMEIRO', primeira);

  // ═══════════════════════════ 2. rodar de novo é no-op
  titulo('2. migration:run DE NOVO (o boot roda a cada deploy)');
  const run2 = npmNo(DO_ZERO, 'migration:run');
  check(run2.ok, 'segunda execução não estoura',
    run2.ok ? '' : run2.saida.split('\n').filter((l) => /error|Error/.test(l))[0]?.slice(0, 140));
  check(Number(psql('SELECT count(*) FROM migrations', DO_ZERO)) === aplicadas,
    'e não registra nada novo (nada foi reaplicado)');

  // ═══════════════════════════ 3. igual ao que as entidades produzem
  titulo('3. O SCHEMA É O MESMO QUE AS ENTIDADES PRODUZEM?');
  criar(DE_ENTIDADES);
  // `schema:sync` do CLI chama dataSource.synchronize() nas MESMAS entidades
  // que a aplicação usa — é o alvo correto de comparação. (Não existe script
  // npm para isso: o data-source tem synchronize:false de propósito, para o
  // CLI nunca mexer no schema por acidente.)
  let sincronizou = true;
  let erroSync = '';
  try {
    execSync('npx typeorm-ts-node-commonjs -d src/data-source.ts schema:sync', {
      cwd: RAIZ_API, encoding: 'utf8', env: envDe(DE_ENTIDADES), stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    sincronizou = false;
    erroSync = ((e.stdout || '') + (e.stderr || '')).split('\n').filter((l) => /error|Error/.test(l))[0]?.slice(0, 160) || '';
  }
  check(sincronizou, 'materializei o schema a partir das entidades (schema:sync)', erroSync);

  const doZero = assinatura(DO_ZERO).split('\n').filter(Boolean);
  const dasEntidades = assinatura(DE_ENTIDADES).split('\n').filter(Boolean);
  check(dasEntidades.length > 200, 'li a assinatura das entidades', `${dasEntidades.length} colunas`);

  const soNoZero = doZero.filter((l) => !dasEntidades.includes(l));
  const soNasEntidades = dasEntidades.filter((l) => !doZero.includes(l));
  check(soNoZero.length === 0 && soNasEntidades.length === 0,
    'as migrations produzem EXATAMENTE o schema das entidades, coluna por coluna',
    soNoZero.length || soNasEntidades.length
      ? `${soNoZero.length} só nas migrations / ${soNasEntidades.length} só nas entidades`
      : `${doZero.length} colunas conferidas`);
  for (const l of [...soNoZero.slice(0, 8).map((x) => `  migration: ${x}`), ...soNasEntidades.slice(0, 8).map((x) => `  entidade:  ${x}`)]) {
    console.log(l);
  }

  // ═══════════════════════════ 4. baseline em banco que já tem schema
  titulo('4. A BASELINE É NO-OP NUM BANCO QUE JÁ TEM O SCHEMA (o snapshot)');
  // Simula o deploy de retomada: schema pronto (feito pelas entidades), nenhuma
  // migration registrada. Se a baseline não fosse idempotente, aqui o boot
  // abortaria — e era esse o risco do KAN-283.
  const semHistorico = npmNo(DE_ENTIDADES, 'migration:run');
  check(semHistorico.ok,
    'migration:run sobre schema existente e SEM histórico não estoura',
    semHistorico.ok ? '' : semHistorico.saida.split('\n').filter((l) => /error|Error/.test(l))[0]?.slice(0, 160));
  check(Number(psql('SELECT count(*) FROM migrations', DE_ENTIDADES)) >= 14,
    'e marca as migrations como aplicadas, deixando o banco em dia');

  // ═══════════════════════════ 5. deduplicação de cupom
  titulo('5. DUPLICATA DE CUPOM NÃO DERRUBA MAIS O BOOT');
  // O cenário é montado à mão, e de propósito: a primeira versão deste passo
  // revertia migrations em cascata até chegar na do cupom, o que dependia da
  // ordem e do estado do histórico, e tentava plantar o cupom no banco do
  // zero — que não tem loja nenhuma (e storeId é NOT NULL). Aqui o banco é
  // próprio: schema completo, índice derrubado, registro da migration
  // apagado. Fica exatamente o estado de produção na véspera do deploy.
  criar(CUPOM);
  const prep = npmNo(CUPOM, 'migration:run');
  check(prep.ok, 'montei um banco completo para o cenário do cupom');

  // A baseline cria a unicidade como CONSTRAINT (vem do @Unique da entidade,
  // dentro do CREATE TABLE), e a migration do cupom cria como INDEX. Para o
  // cenario voltar ao estado anterior aos dois, derruba os dois jeitos.
  psql(`ALTER TABLE coupons DROP CONSTRAINT IF EXISTS "UQ_coupons_code_store"`, CUPOM);
  psql(`DROP INDEX IF EXISTS "UQ_coupons_code_store"`, CUPOM);
  psql(`DELETE FROM migrations WHERE name LIKE '%CouponCodeStoreUnique%'`, CUPOM);
  check(psql(`SELECT count(*) FROM pg_indexes WHERE indexname='UQ_coupons_code_store'`, CUPOM) === '0',
    'o índice único não existe e a migration voltou a estar pendente');

  // Uma loja real, porque coupons.storeId é NOT NULL com FK.
  //
  // `.split` por causa de uma pegadinha do psql: com `INSERT ... RETURNING`,
  // ele imprime o valor E a linha de status ("INSERT 0 1"). Sem cortar, o id
  // vinha como "uuid\nINSERT 0 1" e o INSERT seguinte estourava com
  // "unterminated quoted string" — erro que parece do SQL e é do shell.
  const lojaId = primeiraLinha(psql(
    `INSERT INTO stores (name, phone, street, number, neighborhood, city, state, "zipCode", latitude, longitude) ` +
    `VALUES ('Loja do Ensaio','5391000','Rua X','1','Centro','Pelotas','RS','96000000',-31.77,-52.34) RETURNING id`,
    CUPOM,
  ));
  check(!!lojaId, 'criei a loja do cenário', lojaId);

  psql(
    `INSERT INTO coupons (code, "discountType", "discountValue", "storeId", "createdAt") VALUES ` +
    `('DUPLICADO','PERCENT',10,'${lojaId}','2026-01-01 00:00:00'), ` +
    `('DUPLICADO','PERCENT',10,'${lojaId}','2026-01-02 00:00:00')`,
    CUPOM,
  );
  check(Number(psql(`SELECT count(*) FROM coupons WHERE code='DUPLICADO'`, CUPOM)) === 2,
    'plantei a duplicata que derrubaria o deploy');

  const reaplica = npmNo(CUPOM, 'migration:run');
  check(reaplica.ok, 'migration:run com duplicata na base NÃO aborta o boot',
    reaplica.ok ? '' : reaplica.saida.split('\n').filter((l) => /error|Error|duplicate/.test(l))[0]?.slice(0, 160));
  check(Number(psql(`SELECT count(*) FROM coupons WHERE code LIKE 'DUPLICADO_DUP_%'`, CUPOM)) === 1,
    'uma das duas foi renomeada');
  check(psql(`SELECT code FROM coupons WHERE "createdAt" = '2026-01-01 00:00:00'`, CUPOM) === 'DUPLICADO',
    'e quem manteve o código original foi a MAIS ANTIGA (não é sorteio)');
  check(psql(`SELECT count(*) FROM pg_indexes WHERE indexname='UQ_coupons_code_store'`, CUPOM) === '1',
    'o índice único foi criado depois da limpeza');
} finally {
  for (const db of criados) {
    try { psql(`DROP DATABASE IF EXISTS ${db}`); } catch {}
  }
}

console.log(`\n${ok.length} ok, ${falhas.length} falha(s)`);
if (falhas.length) {
  for (const f of falhas) console.log(`   FALHOU ${f}`);
  process.exit(1);
}
console.log('   produção é reconstituível a partir das migrations.');
