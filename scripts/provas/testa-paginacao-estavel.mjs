// Estressa a ESTABILIDADE da paginacao: varre todas as paginas de uma lista com
// pagina pequena e confere que a uniao das paginas e exatamente o conjunto
// completo — sem item repetido e sem item perdido. Repete varias vezes, porque o
// sintoma de ordem instavel e justamente ser intermitente.
const URL = 'http://localhost:3000/graphql';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? 'OK  ' : 'FALHOU'} ${n}${d ? ' — ' + d : ''}`); };

async function f(q, variables) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

async function varre(campo, extraArgs, pagina) {
  const ids = [];
  for (let offset = 0; ; offset += pagina) {
    const args = `limit:${pagina}, offset:${offset}${extraArgs ? ', ' + extraArgs : ''}`;
    const lista = (await f(`{ ${campo}(${args}) { id } }`))[campo];
    ids.push(...lista.map((x) => x.id));
    if (lista.length < pagina) break;
    if (offset > 2000) throw new Error('varredura nao terminou — suspeita de loop');
  }
  return ids;
}

async function cenario(nome, campo, extraArgs, pagina, repeticoes) {
  const completo = (await f(`{ ${campo}${extraArgs ? '(' + extraArgs + ')' : ''} { id } }`))[campo].map((x) => x.id);
  const conjuntoCompleto = new Set(completo);
  let problemas = 0;
  let detalhe = '';

  for (let i = 0; i < repeticoes; i++) {
    const ids = await varre(campo, extraArgs, pagina);
    const repetidos = ids.length !== new Set(ids).size;
    const perdidos = [...conjuntoCompleto].filter((id) => !ids.includes(id));
    const intrusos = ids.filter((id) => !conjuntoCompleto.has(id));
    if (repetidos || perdidos.length || intrusos.length) {
      problemas++;
      if (!detalhe) {
        detalhe = `rodada ${i + 1}: ${ids.length} coletados vs ${completo.length} esperados` +
          (repetidos ? `, COM REPETIDO` : '') +
          (perdidos.length ? `, ${perdidos.length} PERDIDO(S)` : '') +
          (intrusos.length ? `, ${intrusos.length} INTRUSO(S)` : '');
      }
    }
  }
  check(
    problemas === 0,
    `${nome}: ${repeticoes} varreduras de pagina ${pagina} sobre ${completo.length} itens`,
    problemas === 0 ? 'uniao exata, sem repetido nem perdido' : detalhe,
  );
}

// Promocoes: o caso que motivou o desempate (varias com createdAt praticamente igual)
await cenario('activePromotions', 'activePromotions', '', 1, 8);
await cenario('activePromotions', 'activePromotions', '', 2, 8);

// Lojas, vitrine (ranking pago + recorte da ordem global)
await cenario('stores vitrine', 'stores', 'storeType:"PRODUCTS"', 7, 5);

// Lojas, caminho de BUSCA (ordenado por nome no SQL — onde o desempate entrou)
await cenario('stores busca', 'stores', 'search:"a", storeType:"PRODUCTS"', 3, 5);

// Ordem repetida tem de ser IDENTICA entre chamadas iguais
const a = (await f('{ activePromotions(limit:50) { id } }')).activePromotions.map((x) => x.id).join(',');
const b = (await f('{ activePromotions(limit:50) { id } }')).activePromotions.map((x) => x.id).join(',');
const c = (await f('{ activePromotions(limit:50) { id } }')).activePromotions.map((x) => x.id).join(',');
check(a === b && b === c, 'activePromotions devolve a MESMA ordem em chamadas repetidas');

const s1 = (await f('{ stores(search:"a", storeType:"PRODUCTS", limit:50) { id } }')).stores.map((x) => x.id).join(',');
const s2 = (await f('{ stores(search:"a", storeType:"PRODUCTS", limit:50) { id } }')).stores.map((x) => x.id).join(',');
check(s1 === s2, 'busca de lojas devolve a MESMA ordem em chamadas repetidas');

console.log(`\n===== ${ok.length} OK, ${fail.length} FALHOU =====`);
if (fail.length) { fail.forEach((x) => console.log(' - ' + x)); process.exit(1); }
