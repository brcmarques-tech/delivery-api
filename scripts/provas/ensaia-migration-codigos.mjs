// ENSAIO DAS MIGRATIONS EM BANCO DESCARTAVEL: ELAS CONSTROEM O SCHEMA QUE OS
// TESTES EXERCITARAM?
//
// O problema que isto resolveu: as migrations AddDelivererPayable e
// AddDeliveryCodes nunca tinham sido executadas por ninguem. Eu criei as
// colunas A MAO no banco local para desenvolver a feature de codigos e escrevi
// as migrations em paralelo. Entao os 33 testes E2E dos codigos passaram contra
// colunas feitas a mao, e as migrations — o que vai rodar em producao — eram
// codigo nao-testado.
//
// Ler o arquivo nao resolve. O script irmao `audita-migration-codigos.mjs`
// compara os TEXTOS e me enganou tres vezes seguidas com comparacoes de string
// que erravam para o lado do "OK": nomes de coluna chutados em ingles quando
// estao em portugues, o "@Field()" contado de dentro do comentario que documenta
// a regra, e o backtick do literal colado no nome do tipo. Aqui nao se compara
// texto nenhum. Roda-se.
//
// COMO FUNCIONA
//
//   1. clona o schema de shopping_db num banco novo (sem dados)
//   2. REVERTE as N ultimas migrations no clone, pelo down() delas
//   3. roda migration:run no clone — reaplica as N pelo up()
//   4. compara a assinatura da tabela orders INTEIRA entre clone e referencia
//   5. reaplica por engano, para ver se o boot abortaria
//
// Por que reverter, em vez de derrubar colunas a mao: a primeira versao deste
// script apagava uma lista de 14 colunas que eu mantinha aqui dentro. Funcionou
// enquanto as migrations estavam PENDENTES no banco de referencia. No momento em
// que eu as apliquei localmente, o clone passou a herdar o registro, o TypeORM
// deixou de reaplicar, e o ensaio acusou quatro falhas que eram do script, nao
// do codigo. Usando o down() das proprias migrations, o ensaio nao depende do
// estado do banco nem de lista nenhuma minha.
//
// NAO TOCA no shopping_db em momento algum. O clone e apagado no fim.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'fs';

// scripts/provas/<este arquivo> -> a raiz da API e dois niveis acima.
const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CLONE = 'ensaio_migrations';
const QUANTAS = 2; // migrations a reverter e reaplicar
const ok = [], falhas = [];
const check = (c, n, d = '') => { (c ? ok : falhas).push(n); console.log(`${c ? 'OK  ' : 'FALHOU'} ${n}${d ? ' — ' + d : ''}`); };

const dentro = (cmd, db = 'postgres') =>
  execSync(`docker exec shopping-postgres psql -U shopping -d ${db} -tAc "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const envClone = {
  ...process.env,
  DATABASE_URL: '',
  DB_HOST: 'localhost', DB_PORT: '5432', DB_USERNAME: 'shopping', DB_DATABASE: CLONE,
};
function cli(comando) {
  try {
    return { ok: true, saida: execSync(`npm run ${comando}`, { cwd: RAIZ_API, encoding: 'utf8', env: envClone, stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, saida: (e.stdout || '') + (e.stderr || '') };
  }
}

// Assinatura comparavel da tabela orders INTEIRA.
//
// Era so as 14 colunas dos codigos. Virou a tabela toda porque o proprio ensaio
// mostrou por que: na primeira execucao apareceram DUAS migrations pendentes,
// nao uma. Alem da AddDeliveryCodes havia a AddDelivererPayable, que cria
// `delivererPayableCents` — justamente a coluna onde o tratamento de repasse
// bloqueado escreve. Uma comparacao restrita a uma lista minha nao veria isso, e
// e o tipo de coisa que so aparece no deploy.
const assinatura = (db) => dentro(
  `SELECT column_name || ' | ' || data_type || ' | len=' || coalesce(character_maximum_length::text,'-') ` +
  `|| ' | prec=' || coalesce(numeric_precision::text,'-') || ',' || coalesce(numeric_scale::text,'-') ` +
  `|| ' | null=' || is_nullable || ' | default=' || coalesce(column_default,'-') ` +
  `FROM information_schema.columns WHERE table_name='orders' ORDER BY column_name`,
  db,
);

// As colunas dos codigos saem da ENTIDADE, para a conferencia final de que elas
// estao de fato no clone. Lista escrita a mao envelhece calada.
const ent = fs.readFileSync(path.join(RAIZ_API, 'src/orders/entities/order.entity.ts'), 'utf8');
const bloco = ent.slice(ent.indexOf('Garantia de entrega por C'), ent.indexOf('@CreateDateColumn'));
const campos = [...bloco.matchAll(/@Column\([^)]*\)\s*(?:\/\*\*[\s\S]*?\*\/\s*)?(\w+)[?!]?\s*:/g)].map((m) => m[1]);
check(campos.length === 14, 'li as 14 colunas dos codigos na entidade', String(campos.length));

const esperado = assinatura('shopping_db');
check(esperado.split('\n').length > 40, 'li a assinatura de orders no banco de referencia',
  `${esperado.split('\n').length} colunas`);

let criado = false;
try {
  // ══════════════════════════════ 1. clone
  console.log('\n=== 1. clonando o schema de shopping_db ===');
  dentro(`DROP DATABASE IF EXISTS ${CLONE}`);
  dentro(`CREATE DATABASE ${CLONE} OWNER shopping`);
  criado = true;
  sh(`docker exec shopping-postgres sh -c "pg_dump -U shopping --schema-only shopping_db | psql -U shopping -d ${CLONE} -q"`);
  sh(`docker exec shopping-postgres sh -c "pg_dump -U shopping --data-only --table=migrations shopping_db | psql -U shopping -d ${CLONE} -q"`);

  const nMig = Number(dentro('SELECT count(*) FROM migrations', CLONE));
  check(nMig > 0, 'o clone herdou o historico de migrations', `${nMig} registradas`);
  check(
    Number(dentro("SELECT count(*) FROM information_schema.columns WHERE table_name='orders'", CLONE)) > 40,
    'o clone herdou a tabela orders',
  );

  // ══════════════════════════════ 2. reverter
  console.log(`\n=== 2. revertendo as ${QUANTAS} ultimas migrations no clone (pelo down() delas) ===`);
  const revertidas = [];
  for (let i = 0; i < QUANTAS; i++) {
    const antes = dentro('SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1', CLONE);
    const r = cli('migration:revert');
    if (!r.ok) {
      console.log('   ' + r.saida.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(0, 3).join('\n   '));
      break;
    }
    revertidas.push(antes);
    console.log(`   revertida: ${antes}`);
  }
  check(revertidas.length === QUANTAS, `as ${QUANTAS} reverteram sem erro`, revertidas.join(', '));

  const sumiram = campos.filter(
    (c) => dentro(`SELECT count(*) FROM information_schema.columns WHERE table_name='orders' AND column_name='${c}'`, CLONE) === '0',
  );
  check(sumiram.length === 14, 'o down() removeu as 14 colunas dos codigos (rollback nao deixa lixo)',
    `${sumiram.length}/14 removidas`);

  // ══════════════════════════════ 3. reaplicar
  console.log('\n=== 3. migration:run no clone ===');
  const run = cli('migration:run');
  const aplicadas = (run.saida.match(/Migration (\w+) has been executed/g) || [])
    .map((s) => s.replace(/Migration | has been executed/g, ''));
  aplicadas.forEach((m) => console.log('   aplicada: ' + m));
  check(run.ok, 'o CLI do TypeORM reaplicou as migrations sem erro',
    run.ok ? '' : (run.saida.split(/\r?\n/).filter((l) => /error/i.test(l))[0] || 'veja a saida'));
  check(aplicadas.length === QUANTAS, `reaplicou exatamente as ${QUANTAS} revertidas`,
    `${aplicadas.length} aplicada(s)`);
  check(revertidas.every((r) => aplicadas.includes(r)),
    'as reaplicadas sao as mesmas que foram revertidas');

  // ══════════════════════════════ 4. o schema resultante bate?
  console.log('\n=== 4. assinatura de orders: clone x banco de referencia ===');
  const a = esperado.split('\n').map((s) => s.trim());
  const b = assinatura(CLONE).split('\n').map((s) => s.trim());
  const soEm = (x, y) => x.filter((l) => !y.includes(l));
  const faltam = soEm(a, b), sobram = soEm(b, a);

  if (!faltam.length && !sobram.length) {
    console.log(`   as ${b.length} colunas de orders batem linha por linha (nome, tipo,`);
    console.log('   tamanho, precisao, nullable e default).');
  } else {
    faltam.forEach((l) => console.log('   ! so na referencia: ' + l));
    sobram.forEach((l) => console.log('   ! so no clone:      ' + l));
  }
  check(!faltam.length && !sobram.length,
    'as migrations reproduzem EXATAMENTE o schema contra o qual os testes passaram',
    `${b.length} colunas, ${faltam.length + sobram.length} divergencia(s)`);

  // O check acima tambem passaria num mundo onde nenhuma das colunas existisse.
  const presentes = campos.filter((c) => b.some((l) => l.startsWith(c + ' |')));
  check(presentes.length === 14, 'e as 14 colunas dos codigos estao presentes no clone', `${presentes.length}/14`);

  // ══════════════════════════════ 5. idempotencia
  console.log('\n=== 5. reaplicar por engano aborta o boot? ===');
  for (const m of revertidas) dentro(`DELETE FROM migrations WHERE name='${m}'`, CLONE);
  const r2 = cli('migration:run');
  if (!r2.ok) console.log('   ' + r2.saida.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(0, 4).join('\n   '));
  check(r2.ok, 'reaplicar em banco que JA TEM as colunas nao aborta',
    r2.ok ? 'o IF NOT EXISTS cumpriu o papel' : 'o boot abortaria num reapply');
} finally {
  if (criado) {
    try { dentro(`DROP DATABASE IF EXISTS ${CLONE} WITH (FORCE)`); console.log(`\n(banco de ensaio ${CLONE} apagado)`); }
    catch { console.log(`\n!! apague a mao: DROP DATABASE ${CLONE};`); }
  }
}

console.log(`\n=== ${ok.length} ok, ${falhas.length} falha(s) ===`);
if (falhas.length) { falhas.forEach((f) => console.log('   ! ' + f)); process.exit(1); }
