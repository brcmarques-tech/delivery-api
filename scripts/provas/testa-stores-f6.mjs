// Valida a query `stores` depois do F6: compatibilidade (sem args = igual a
// antes), filtros no servidor e paginacao respeitando a ordem global.
const URL = 'http://localhost:3000/graphql';
const ok = [];
const fail = [];
function check(cond, nome, detalhe = '') {
  (cond ? ok : fail).push(nome);
  console.log(`${cond ? 'OK  ' : 'FALHOU'} ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}
async function q(query, variables) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

const CAMPOS = 'id name storeType isOpen freeDelivery description';

// 1. sem argumentos — comportamento de antes
const todas = (await q(`{ stores { ${CAMPOS} } }`)).stores;
check(todas.length > 0, 'sem args devolve a vitrine', `${todas.length} lojas`);

// 2. paginacao respeita a ordem GLOBAL (pagina = recorte da lista cheia)
const pag1 = (await q(`query($l:Int,$o:Int){ stores(limit:$l, offset:$o){ id name } }`, { l: 5, o: 0 })).stores;
const pag2 = (await q(`query($l:Int,$o:Int){ stores(limit:$l, offset:$o){ id name } }`, { l: 5, o: 5 })).stores;
check(pag1.length === 5, 'limit 5 devolve 5', `${pag1.length}`);
const idsGlobais = todas.map((s) => s.id);
const fatia = idsGlobais.slice(0, 5).join(',');
check(pag1.map((s) => s.id).join(',') === fatia, 'pagina 1 == primeiros 5 da ordem global');
const fatia2 = idsGlobais.slice(5, 10).join(',');
check(pag2.map((s) => s.id).join(',') === fatia2, 'pagina 2 == itens 6-10 da ordem global');
const sobreposicao = pag1.filter((a) => pag2.some((b) => b.id === a.id));
check(sobreposicao.length === 0, 'paginas nao se sobrepoem');

// 3. limite maximo respeitado (clamp em 100)
const exagero = (await q(`query($l:Int){ stores(limit:$l){ id } }`, { l: 9999 })).stores;
check(exagero.length <= 100, 'limit absurdo e limitado a 100', `${exagero.length}`);

// 4. filtro por tipo — inclui storeType NULL como PRODUCTS
const produtos = (await q(`query($t:String){ stores(storeType:$t){ id storeType } }`, { t: 'PRODUCTS' })).stores;
const todosProdutos = produtos.every((s) => !s.storeType || s.storeType === 'PRODUCTS');
check(todosProdutos, 'storeType PRODUCTS inclui os NULL e exclui SERVICES', `${produtos.length} lojas`);
const servicos = (await q(`query($t:String){ stores(storeType:$t){ id storeType } }`, { t: 'SERVICES' })).stores;
check(servicos.every((s) => s.storeType === 'SERVICES'), 'storeType SERVICES so traz SERVICES', `${servicos.length}`);
const esperado = todas.filter((s) => !s.storeType || s.storeType === 'PRODUCTS').length;
check(produtos.length === esperado, 'contagem de PRODUCTS bate com o filtro client-side antigo', `${produtos.length} vs ${esperado}`);

// 5. onlyOpen / onlyFreeDelivery
const abertas = (await q(`{ stores(onlyOpen:true){ id isOpen } }`)).stores;
check(abertas.every((s) => s.isOpen), 'onlyOpen so traz loja aberta', `${abertas.length}`);
check(abertas.length === todas.filter((s) => s.isOpen).length, 'contagem de abertas bate com o filtro antigo');
const frete = (await q(`{ stores(onlyFreeDelivery:true){ id freeDelivery } }`)).stores;
check(frete.every((s) => s.freeDelivery), 'onlyFreeDelivery so traz frete gratis', `${frete.length}`);

// 6. busca por nome — compara com o que o filtro client-side acharia
const alvo = todas.find((s) => (s.name || '').length > 4);
const termo = alvo.name.slice(1, 5);
const achadas = (await q(`query($s:String){ stores(search:$s){ id name } }`, { s: termo })).stores;
const esperadas = todas.filter(
  (s) =>
    (s.name || '').toLowerCase().includes(termo.toLowerCase()) ||
    (s.description || '').toLowerCase().includes(termo.toLowerCase()),
);
const achouTodas = esperadas.every((e) => achadas.some((a) => a.id === e.id));
check(achouTodas, `busca "${termo}" acha tudo que o filtro antigo achava`, `${achadas.length} >= ${esperadas.length}`);
const ordenadaPorNome = achadas.every(
  (s, i) => i === 0 || (achadas[i - 1].name || '').localeCompare(s.name || '') <= 0,
);
check(ordenadaPorNome, 'resultado de busca vem ordenado por nome (como a tela ordena)');

// 7. busca ignora acento (melhoria sobre o includes() do cliente)
const comAcento = todas.find((s) => /[áàâãéêíóôõúç]/i.test(s.name || ''));
if (comAcento) {
  const semAcento = comAcento.name.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const r = (await q(`query($s:String){ stores(search:$s){ id name } }`, { s: semAcento })).stores;
  check(r.some((s) => s.id === comAcento.id), `busca sem acento acha "${comAcento.name}"`, `termo: "${semAcento}"`);
} else {
  console.log('--  nenhuma loja com acento no nome para testar unaccent');
}

// 8. busca + tipo combinados
const combo = (await q(`query($s:String,$t:String){ stores(search:$s, storeType:$t){ id storeType } }`, { s: termo, t: 'PRODUCTS' })).stores;
check(combo.every((s) => !s.storeType || s.storeType === 'PRODUCTS'), 'busca + storeType combinam');

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { console.log('falhas:'); fail.forEach((f) => console.log(' - ' + f)); process.exit(1); }
