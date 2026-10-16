// A MIGRATION DOS CODIGOS BATE COM A ENTIDADE, COM O BANCO E COM A REGRA?
//
// Por que isso merece script proprio: durante o desenvolvimento eu alterei o
// banco LOCAL a mao para testar, e escrevi a migration em paralelo. As duas
// coisas podem divergir sem nada falhar aqui — o E2E passa porque o banco local
// tem as colunas, independente de a migration estar correta. A conta so chega no
// deploy, e o sistema ainda nao esta no ar: a migration
// 1786500000000-AddDeliveryCodes NUNCA FOI EXECUTADA, nem aqui.
//
// Compara tres fontes:
//   a entidade order.entity.ts  — o que o codigo espera
//   a migration                 — o que vai existir em producao
//   o banco local               — onde os testes passaram
//
// NOTA SOBRE A PRIMEIRA VERSAO DESTE SCRIPT, que me enganou duas vezes:
//
//  1. Procurei os nomes das colunas por prefixos em INGLES (deliveryCode,
//     storePickupCode). Elas estao em PORTUGUES. Encontrei zero colunas, e
//     entao sete checagens deram "OK" comparando conjunto vazio com conjunto
//     vazio — sete provas de nada. Agora os nomes saem do proprio bloco.
//  2. A checagem do @Field() contou o "@Field()" escrito dentro do COMENTARIO
//     que documenta a regra. A auditoria quase acusou a documentacao da regra
//     de violar a regra.
//
// Um script de auditoria que erra para o lado do "OK" e pior que nenhum.
import fs from 'fs';
import { execSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// scripts/provas/<este arquivo> -> a raiz da API e dois niveis acima.
const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');


const API = path.join(RAIZ_API, 'src');
const ok = [], falhas = [];
const check = (c, n, d = '') => { (c ? ok : falhas).push(n); console.log(`${c ? 'OK  ' : 'FALHOU'} ${n}${d ? ' — ' + d : ''}`); };

const sql = (q) => execSync(
  `docker exec shopping-postgres psql -U shopping -d shopping_db -tAc "${q.replace(/"/g, '\\"')}"`,
  { encoding: 'utf8' },
).trim();

// ══════════════════════════════════════════════ 1. a entidade
const ent = fs.readFileSync(API + '/orders/entities/order.entity.ts', 'utf8');

// CORRECAO 1: os nomes vem do bloco, do cabecalho da secao ate o createdAt.
const iBloco = ent.indexOf('Garantia de entrega por C');
const iFim = ent.indexOf('@CreateDateColumn');
if (iBloco < 0 || iFim < 0 || iFim < iBloco) {
  console.error('nao localizei o bloco de codigos na entidade — nao audito as cegas');
  process.exit(1);
}
const bloco = ent.slice(iBloco, iFim);

const campos = [];
const re = /@Column\(([^)]*)\)\s*(?:\/\*\*[\s\S]*?\*\/\s*)?(\w+)[?!]?\s*:/g;
let m;
while ((m = re.exec(bloco)) !== null) campos.push(m[2]);

console.log(`=== 1. entidade: ${campos.length} colunas na secao de codigos ===`);
campos.forEach((c) => console.log('   ' + c));
check(campos.length === 14, 'a entidade declara as 14 colunas da feature', String(campos.length));

// CORRECAO 2: tira comentarios e corta no ultimo @Column antes de procurar.
const semComentarios = bloco
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');
const ultimo = semComentarios.lastIndexOf('@Column(');
const blocoLimpo = ultimo >= 0
  ? semComentarios.slice(0, semComentarios.indexOf(';', ultimo) + 1)
  : semComentarios;
const fields = (blocoLimpo.match(/@Field\(/g) || []).length;
check(
  fields === 0,
  'REGRA INVIOLAVEL: nenhuma coluna de codigo tem @Field()',
  fields === 0
    ? `zero em ${campos.length} colunas — o tipo Order nao expoe codigo nenhum`
    : `${fields} @Field() EM COLUNA DE CODIGO — O ENTREGADOR LERIA O CODIGO DO CLIENTE`,
);

// ══════════════════════════════════════════════ 2. a migration
const arq = fs.readdirSync(API + '/migrations').find((f) => f.includes('AddDeliveryCodes'));
check(!!arq, 'a migration existe no repo', arq || 'NAO ENCONTRADA');
if (!arq) process.exit(1);
const mig = fs.readFileSync(API + '/migrations/' + arq, 'utf8');
const classe = (mig.match(/export class (\w+)/) || [])[1];

console.log(`\n=== 2. migration ${arq} ===`);

const iUp = mig.search(/public async up/);
const iDown = mig.search(/public async down/);
const trechoUp = iDown > iUp ? mig.slice(iUp, iDown) : mig.slice(iUp);
const trechoDown = iDown >= 0 ? mig.slice(iDown) : '';
const nomeEm = (t, c) => t.includes(`'${c}'`) || t.includes(`"${c}"`);

const faltaUp = campos.filter((c) => !nomeEm(trechoUp, c));
check(faltaUp.length === 0, 'o up() cria TODAS as colunas que a entidade declara',
  faltaUp.length ? 'FALTAM: ' + faltaUp.join(', ') : `${campos.length}/${campos.length}`);

check(!!trechoDown, 'a migration tem down()');
// CORRECAO: o down() percorre um array de nomes em aspas SIMPLES e interpola.
// A versao anterior procurava aspas DUPLAS e concluiu 0/14 — o down() estava
// certo desde o inicio e a auditoria errada.
const faltaDown = campos.filter((c) => !nomeEm(trechoDown, c));
check(faltaDown.length === 0, 'o down() desfaz todas as colunas do up()',
  faltaDown.length ? 'FALTAM: ' + faltaDown.join(', ') : `${campos.length}/${campos.length}`);

check(/IF NOT EXISTS/i.test(trechoUp), 'o up() usa IF NOT EXISTS (tolera coluna preexistente)');
check(/DROP COLUMN IF EXISTS/i.test(trechoDown), 'o down() usa DROP COLUMN IF EXISTS');

// Colunas que a migration cria mas a entidade NAO declara: lixo que ninguem le.
const soNaMigration = (trechoUp.match(/ADD COLUMN IF NOT EXISTS "(\w+)"/gi) || [])
  .map((s) => s.match(/"(\w+)"/)[1])
  .filter((c) => !campos.includes(c));
check(soNaMigration.length === 0, 'a migration nao cria coluna que a entidade ignora',
  soNaMigration.length ? 'SOBRANDO: ' + soNaMigration.join(', ') : 'nenhuma sobrando');

// ══════════════════════════════════════════════ 3. o banco local
const colsBanco = sql(
  `SELECT column_name FROM information_schema.columns WHERE table_name='orders'`,
).split('\n').map((s) => s.trim());
console.log(`\n=== 3. banco local: ${colsBanco.length} colunas em orders ===`);
const faltaBanco = campos.filter((c) => !colsBanco.includes(c));
check(faltaBanco.length === 0, 'o banco local tem todas as colunas da entidade',
  faltaBanco.length ? 'FALTAM: ' + faltaBanco.join(', ') : 'todas');

// ══════════════════════════════════════════════ 4. os tipos batem?
// O que quebra em silencio: varchar curto demais para o valor, ou NOT NULL sem
// default numa tabela que ja tem linhas — isso aborta o boot inteiro.
console.log('\n=== 4. tipo no banco x tipo prometido na migration ===');
let divergentes = 0;
for (const c of campos) {
  if (!colsBanco.includes(c)) continue;
  const t = sql(
    `SELECT data_type || coalesce('(' || character_maximum_length || ')','') ` +
    `|| ' null=' || is_nullable FROM information_schema.columns ` +
    `WHERE table_name='orders' AND column_name='${c}'`,
  );
  const linha = trechoUp.split(/\r?\n/).find((l) => l.includes(`"${c}"`) && /ADD COLUMN/i.test(l)) || '';
  // O literal da migration termina em backtick+virgula. Sem tirar isso, TIMESTAMP
  // (que nao tem parenteses) chegava como "TIMESTAMP`," e nao casava com nada —
  // 5 falsas divergencias. As colunas com parenteses escapavam porque o split no
  // "(" ja jogava o lixo fora.
  const prometido = (linha.match(/ADD COLUMN IF NOT EXISTS "w+"s+(.+)$/i) || [, '?'])[1]
    .trim()
    .replace(/[^A-Za-z0-9)s,(]+$/, '')
    .replace(/,$/, '')
    .trim();

  const base = prometido.split(/[\s(]/)[0].toLowerCase();
  const esperado = base === 'varchar' ? 'character varying'
    : base === 'timestamp' ? 'timestamp'
    : base;
  const casa = t.toLowerCase().includes(esperado);
  if (!casa) divergentes++;
  console.log(`   ${casa ? ' ' : '!'} ${c.padEnd(26)} banco: ${t.padEnd(38)} migration: ${prometido}`);
}
check(divergentes === 0, 'nenhum tipo divergente entre banco e migration', `${divergentes} divergencia(s)`);

const notNullSemDefault = (trechoUp.match(/ADD COLUMN IF NOT EXISTS "(\w+)"[^\n]*NOT NULL[^\n]*/gi) || [])
  .filter((l) => !/DEFAULT/i.test(l))
  .map((s) => s.match(/"(\w+)"/)[1]);
check(notNullSemDefault.length === 0,
  'nenhuma coluna NOT NULL sem DEFAULT (abortaria o boot numa tabela com linhas)',
  notNullSemDefault.length ? notNullSemDefault.join(', ') : 'nenhuma');

// ══════════════════════════════════════════════ 5. ela ja rodou?
const rodadas = sql('SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 6');
console.log('\n=== 5. ultimas migrations registradas no banco local ===');
rodadas.split('\n').forEach((s) => console.log('   ' + s.trim()));
const registrada = rodadas.includes(classe);
console.log(`\n   >>> ${classe}: ${registrada ? 'REGISTRADA (rodou de verdade)' : 'NUNCA EXECUTADA'}`);
if (!registrada) {
  console.log('       Esperado: eu criei as colunas A MAO para testar a feature. Entao a');
  console.log('       migration e codigo nao-executado no caminho de deploy. As checagens');
  console.log('       acima leem o ARQUIVO; quem prova que ela RODA e o ensaio em banco');
  console.log('       descartavel: bcmTech/ensaia-migration-codigos.mjs');
}

console.log(`\n=== ${ok.length} ok, ${falhas.length} falha(s) ===`);
if (falhas.length) { falhas.forEach((f) => console.log('   ! ' + f)); process.exit(1); }
