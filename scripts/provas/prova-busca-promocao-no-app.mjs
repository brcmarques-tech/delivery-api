// ═══════════════════════════════════════════════════════════════════════════
// KAN-297 — A BUSCA DO APP NÃO PODE ABRIR UM OVERLAY VAZIO E CALADO
// ═══════════════════════════════════════════════════════════════════════════
//
// O bug: `matchingPromos` filtrava as promoções pelo termo digitado e
// alimentava SÓ o `hasResults` — a variável que decide se o estado "Nenhum
// resultado para X" aparece. Promoção casada não era desenhada em lugar
// nenhum do overlay. Então, quando o termo casava SÓ com uma promoção, a
// lista saía vazia E a mensagem era suprimida: o cliente digitava, o overlay
// abria, e não havia nada dentro.
//
// A correção (opção 1 do ticket): a promoção casada virou item do overlay,
// na frente das lojas, porque promoção é canal PAGO (tem adCost) — o lojista
// paga justamente por essa posição.
//
// POR QUE ESTA PROVA É ESTÁTICA: a tela é React Native e não há aparelho nem
// Metro nesta máquina. Então ela checa as três coisas que quebram de verdade,
// e que nenhum teste de backend pegaria:
//
//   1. a fiação (promoção na lista, linha renderizada, rota de destino);
//   2. ordem de declaração — `matchingPromos` usado antes de existir derruba
//      a tela com ReferenceError, e isso NÃO aparece no tsc dentro de um
//      useMemo em alguns arranjos;
//   3. CAMPO POR CAMPO: todo `promo.x` que a linha nova lê tem que estar na
//      seleção de GET_ACTIVE_PROMOTIONS. É o jeito realista de isto voltar a
//      quebrar: alguém enxuga a query, o campo vem `undefined`, e o desconto
//      ou o preço desaparecem da tela sem erro nenhum.
import { readFileSync } from 'node:fs';

const APP = 'D:/linux/Documents/bcmTech/shopping-admin';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
const titulo = (t) => console.log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);

const tela = readFileSync(`${APP}/app/(tabs)/search.tsx`, 'utf8');
const queries = readFileSync(`${APP}/src/lib/graphql/queries.ts`, 'utf8');

titulo('1. A PROMOÇÃO CASADA É MESMO RENDERIZADA?');

check(/\|\s*\{\s*tipo:\s*'promo'/.test(tela), "o overlay tem um tipo de item 'promo'");

const bloco = tela.slice(
  tela.indexOf('const autocompleteItems'),
  tela.indexOf('const renderAutocompleteItem'),
);
check(/matchingPromos/.test(bloco), 'as promoções casadas entram na lista do overlay');
check(/matchingPromos/.test(bloco.slice(bloco.indexOf('}, ['))) ,
  'e estão nas dependências do useMemo (sem isso a lista congela no primeiro termo)');

const ramoPromo = (() => {
  const i = tela.indexOf("if (item.tipo === 'promo')");
  if (i < 0) return '';
  return tela.slice(i, tela.indexOf("if (item.tipo === 'store')", i));
})();
check(!!ramoPromo, 'existe um ramo de renderização para o item de promoção');
check(/router\.push\(`\/promotion\/\$\{promo\.id\}`\)/.test(ramoPromo),
  'e ele leva para a tela da promoção (não para a loja, que perderia a oferta)');
check(/Oferta/.test(ramoPromo),
  'a linha se identifica como oferta (senão ela aparece no topo sem explicação)');

titulo('2. ORDEM DE DECLARAÇÃO (ReferenceError em tela é tela branca)');
const iMatching = tela.indexOf('const matchingPromos');
const iItems = tela.indexOf('const autocompleteItems');
check(iMatching > 0 && iItems > 0 && iMatching < iItems,
  '`matchingPromos` é declarado ANTES de `autocompleteItems`',
  `matchingPromos@${iMatching} < autocompleteItems@${iItems}`);

titulo('3. O ESTADO VAZIO VOLTOU A SER COERENTE');
const hasResults = tela.slice(tela.indexOf('const hasResults'), tela.indexOf('const hasCategoryResults'));
check(/matchingPromos\.length > 0/.test(hasResults),
  '`hasResults` conta as promoções — e agora isso é verdade, porque elas aparecem');
check(/!hasResults && debouncedQuery\.length >= 2/.test(tela),
  'o "Nenhum resultado" continua aparecendo quando NADA casou');

titulo('4. A QUERY ENTREGA OS CAMPOS QUE A LINHA NOVA LÊ?');
const selecao = queries.slice(
  queries.indexOf('export const GET_ACTIVE_PROMOTIONS'),
  queries.indexOf('`;', queries.indexOf('export const GET_ACTIVE_PROMOTIONS')),
);
const dentroDe = (caminho, campo) => {
  // bloco do objeto aninhado (product { ... } / store { ... }) ou a raiz
  if (!caminho) return new RegExp(`^\\s*${campo}\\s*$`, 'm').test(selecao);
  const i = selecao.indexOf(`${caminho} {`);
  if (i < 0) return false;
  const fim = selecao.indexOf('      }', i);
  return new RegExp(`^\\s*${campo}\\s*$`, 'm').test(selecao.slice(i, fim));
};

// Campos lidos pela linha, extraídos do PRÓPRIO código (lista escrita à mão
// envelhece calada — foi assim que a seleção do CREATE_ORDER do site ficou
// incompleta por meses).
const lidosRaiz = [...new Set([...ramoPromo.matchAll(/promo\.(\w+)/g)].map((m) => m[1]))]
  .filter((c) => !['product', 'store'].includes(c));
const lidosProduto = [...new Set([...ramoPromo.matchAll(/promo\.product\?\.(\w+)/g)].map((m) => m[1]))];
const lidosLoja = [...new Set([...ramoPromo.matchAll(/promo\.store\?\.(\w+)/g)].map((m) => m[1]))];

check(lidosRaiz.length + lidosProduto.length + lidosLoja.length > 0,
  'consegui extrair do código os campos que a linha lê',
  `${lidosRaiz.join(',')} | product: ${lidosProduto.join(',')} | store: ${lidosLoja.join(',')}`);
for (const c of lidosRaiz) check(dentroDe('', c), `a query pede \`${c}\``);
for (const c of lidosProduto) check(dentroDe('product', c), `a query pede \`product.${c}\``);
for (const c of lidosLoja) check(dentroDe('store', c), `a query pede \`store.${c}\``);

titulo(`RESULTADO: ${ok.length} ok, ${fail.length} falha(s)`);
if (fail.length) {
  for (const f of fail) console.log(`   ❌ ${f}`);
  process.exit(1);
}
console.log('   buscar por uma oferta mostra a oferta.');
