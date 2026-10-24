// AS OPERAÇÕES GRAPHQL DOS APPS BATEM COM O SCHEMA DA API?
//
// Por que isto existe: `npx tsc --noEmit` passa com qualquer bobagem dentro de
// um `gql` — para o TypeScript aquilo é uma string. Então um campo que não
// existe, um argumento com tipo errado ou uma mutation renomeada só aparecem
// quando a tela é aberta, no celular, em runtime.
//
// Foi exatamente o que aconteceu ao escrever a UI dos códigos: eu selecionei
// `entregaSemCodigoEm` numa mutation e o typecheck passou liso — aquele campo
// não tem @Field() e a operação ia estourar na primeira chamada. Peguei por
// sorte, olhando a entidade por outro motivo.
//
// COMO FUNCIONA
//
//   1. introspecta a API local e monta o schema do cliente
//   2. varre os repos dos apps procurando literais `gql` ... `
//   3. faz parse e valida cada documento contra o schema
//
// Documentos com interpolação (`${...}`) não dão para validar: o texto final só
// existe em runtime. Esses são CONTADOS e listados, não ignorados em silêncio —
// saber quantos escapam da rede é parte do resultado.
//
// Uso: node scripts/provas/valida-graphql-dos-apps.mjs
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClientSchema,
  getIntrospectionQuery,
  parse,
  validate,
} from 'graphql';

const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAIZ_REPOS = path.resolve(RAIZ_API, '..');
const URL_API = process.env.API_URL || 'http://localhost:3000/graphql';

const APPS = [
  'shopping-admin',
  'shopping-vendor-panel',
  'shopping-superadmin',
  'shopping-storefront',
];

// ─────────────────────────────── schema
const r = await fetch(URL_API, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: getIntrospectionQuery() }),
});
const introspeccao = await r.json();
if (!introspeccao?.data?.__schema) {
  console.error(`nao consegui introspectar ${URL_API} — a API esta no ar?`);
  if (introspeccao?.errors) console.error(JSON.stringify(introspeccao.errors).slice(0, 300));
  process.exit(1);
}
const schema = buildClientSchema(introspeccao.data);
console.log(`=== schema lido de ${URL_API} ===\n`);

// ─────────────────────────────── varredura dos arquivos
function arquivos(dir, acc = []) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entradas) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.next' || e.name === '.expo') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivos(p, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

// Extrai o conteúdo de cada `gql` ... ` ou `graphql` ... ` do arquivo.
//
// Não uso regex para achar o fim do literal: template literal pode conter
// `${...}` com crases dentro, e uma regex gulosa casaria o arquivo inteiro.
// Percorro caractere por caractere contando as chaves da interpolação.
// O lookbehind não é enfeite. Sem ele, a primeira versão acusou dois "erros"
// em apollo.ts, onde a linha é:
//
//     const API_URL = `${httpBaseUrl()}/graphql`;
//
// O texto "graphql" ali é o FIM DO CAMINHO da URL, e vem imediatamente seguido
// da crase que fecha o template — forma idêntica a uma tag. Exigir que o
// caractere anterior não seja de palavra, nem `/`, `$` ou `.`, distingue a tag
// do pedaço de URL.
function extrairDocumentos(texto) {
  const docs = [];
  const re = /(?<![\w/$.])(gql|graphql)\s*`/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    let i = m.index + m[0].length;
    const inicio = i;
    let profundidade = 0;
    let temInterpolacao = false;
    while (i < texto.length) {
      const c = texto[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && texto[i + 1] === '{') { temInterpolacao = true; profundidade++; i += 2; continue; }
      if (profundidade > 0) {
        if (c === '{') profundidade++;
        else if (c === '}') profundidade--;
        i++;
        continue;
      }
      if (c === '`') break;
      i++;
    }
    const linha = texto.slice(0, m.index).split('\n').length;
    docs.push({ texto: texto.slice(inicio, i), linha, temInterpolacao });
    re.lastIndex = i + 1;
  }
  return docs;
}

const problemas = [];
const interpolados = [];
let validados = 0;
let arquivosVistos = 0;

for (const app of APPS) {
  const raiz = path.join(RAIZ_REPOS, app);
  if (!fs.existsSync(raiz)) { console.log(`(${app} nao encontrado, pulando)`); continue; }

  let doApp = 0, probsDoApp = 0, interpDoApp = 0;
  for (const arq of arquivos(raiz)) {
    const texto = fs.readFileSync(arq, 'utf8');
    if (!/\b(gql|graphql)\s*`/.test(texto)) continue;
    arquivosVistos++;
    const rel = path.relative(RAIZ_REPOS, arq).replace(/\\/g, '/');

    for (const doc of extrairDocumentos(texto)) {
      if (doc.temInterpolacao) {
        interpDoApp++;
        interpolados.push(`${rel}:${doc.linha}`);
        continue;
      }
      let ast;
      try {
        ast = parse(doc.texto);
      } catch (e) {
        probsDoApp++;
        problemas.push({ onde: `${rel}:${doc.linha}`, tipo: 'nao faz parse', msg: e.message.split('\n')[0] });
        continue;
      }
      const erros = validate(schema, ast);
      if (erros.length) {
        probsDoApp++;
        for (const erro of erros) {
          problemas.push({ onde: `${rel}:${doc.linha}`, tipo: 'invalido', msg: erro.message });
        }
        continue;
      }
      doApp++;
      validados++;
    }
  }
  console.log(
    `${app.padEnd(24)} ${String(doApp).padStart(3)} ok   ` +
    `${String(probsDoApp).padStart(2)} com problema   ${String(interpDoApp).padStart(2)} com interpolacao`,
  );
}

console.log(`\n${validados} operacao(oes) validada(s) em ${arquivosVistos} arquivo(s).`);

if (interpolados.length) {
  console.log(`\n${interpolados.length} documento(s) com interpolacao, fora do alcance desta rede:`);
  for (const i of interpolados.slice(0, 25)) console.log('   ~ ' + i);
  if (interpolados.length > 25) console.log(`   ... e outros ${interpolados.length - 25}`);
  console.log('   (o texto final so existe em runtime; nao da para validar aqui)');
}

if (problemas.length === 0) {
  console.log('\nOK   nenhuma operacao divergente do schema.');
  process.exit(0);
}

console.log(`\nFALHOU  ${problemas.length} problema(s):\n`);
for (const p of problemas) {
  console.log(`  ${p.onde}`);
  console.log(`     [${p.tipo}] ${p.msg}`);
}
console.log('\n  Campo inexistente ou argumento errado aqui nao quebra o build: quebra');
console.log('  a tela, no celular, na mao de quem esta usando.');
process.exit(1);
