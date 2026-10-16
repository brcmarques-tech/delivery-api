// AUDITORIA por CLASSE DE BUG.
//
// Hoje tres defeitos apareceram, e cada um nao era caso isolado: era um PADRAO
// que podia estar em outros lugares. Este script varre o codigo procurando as
// tres classes, em vez de eu confiar em ter achado todas as ocorrencias no
// caminho.
//
//   CLASSE 1 — `.length` em resultado de query crua de ESCRITA.
//     UPDATE/INSERT/DELETE com RETURNING devolve [linhas, contagem] no driver do
//     TypeORM: array de comprimento 2 SEMPRE. Entao `r.length === 0` nunca e
//     verdade e o claim atomico nao protege nada. Foram 23 sites.
//     ATENCAO: em SELECT o `.length` esta CORRETO — ali vem array de linhas de
//     verdade. A primeira versao deste script nao distinguia os dois e acusou 12
//     falsos positivos.
//
//   CLASSE 2 — forma de resposta/rota do Pagar.me herdada da v4.
//     `waiting_funds.amount` (aninhado) nao existe na v5, que usa
//     `waiting_funds_amount` (plano). Idem rotas: /anticipations,
//     /charges/{id}/refund, PATCH /subscriptions/{id}, source_recipient_id.
//
//   CLASSE 3 — HTTP 200 tratado como sucesso num caminho de dinheiro.
//     O DELETE de cobranca responde 200 mesmo quando o estorno FALHA; a verdade
//     esta em `last_transaction.status`.
import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'node:url';

// scripts/provas/<este arquivo> -> a raiz da API e dois niveis acima.
const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');


const RAIZ = path.join(RAIZ_API, 'src');

function arquivos(dir) {
  const saida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...arquivos(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) saida.push(p);
  }
  return saida;
}
const todos = arquivos(RAIZ);
const rel = (p) => p.replace(/\\/g, '/').split('/src/').pop();

let aConferir = 0;

// ─────────────────────────────────────────────── CLASSE 1
console.log('='.repeat(74));
console.log('CLASSE 1 — `.length` em resultado de query de ESCRITA (claim morto)');
console.log('='.repeat(74));
{
  const suspeitos = [];
  let usosDoHelper = 0;
  const arquivosComHelper = new Set();

  for (const f of todos) {
    const txt = fs.readFileSync(f, 'utf8');
    const linhas = txt.split(/\r?\n/);

    const n = (txt.match(/linhasAfetadas\(|claimGanho\(/g) || []).length;
    if (n > 0) { usosDoHelper += n; arquivosComHelper.add(rel(f)); }

    for (let i = 0; i < linhas.length; i++) {
      const l = linhas[i];
      if (!/\.length\b/.test(l)) continue;
      if (/linhasAfetadas|claimGanho/.test(l)) continue;
      if (/^\s*\*|^\s*\/\//.test(l)) continue; // comentario

      // Pega o SQL da janela acima e classifica: escrita ou leitura?
      const janela = linhas.slice(Math.max(0, i - 14), i).join('\n');
      if (!/\.query\(/.test(janela)) continue;
      const sql = janela.slice(janela.lastIndexOf('.query(')).toUpperCase();
      const ehEscrita = /\b(UPDATE|INSERT|DELETE)\b/.test(sql);
      if (!ehEscrita) continue; // SELECT: `.length` esta correto

      suspeitos.push({ f: rel(f), n: i + 1, l: l.trim() });
    }
  }

  // TRIAGEM DE 15/10/2026: dois falsos positivos, verificados por LEITURA.
  //
  // A heuristica olha 14 linhas acima procurando UPDATE/INSERT/DELETE. Quando o
  // SQL que ela acha na janela e de escrita, mas o `.length` daquela linha e de
  // outra coisa, ela acusa sem motivo.
  const triados1 = [
    [
      'lockedOrder.length === 0',
      'FALSO POSITIVO: e um SELECT ... FOR UPDATE. SELECT devolve a lista de linhas de verdade, entao .length esta correto ali.',
    ],
    [
      'return expiredOrders.length',
      'FALSO POSITIVO: expiredOrders vem de um .find() do repositorio, nao de query(). E a contagem de retorno do scheduler.',
    ],
  ];
  const nota1 = (l) => (triados1.find(([p]) => l.includes(p)) || [])[1];
  const novos1 = suspeitos.filter((s) => !nota1(s.l));
  const velhos1 = suspeitos.filter((s) => nota1(s.l));

  if (suspeitos.length === 0) {
    console.log('  Nenhuma. Todo claim de escrita decide por linhasAfetadas/claimGanho.');
  } else {
    if (novos1.length) {
      aConferir += novos1.length;
      console.log('  NAO TRIADOS:');
      for (const s of novos1) console.log(`  !! ${s.f}:${s.n}\n       ${s.l}`);
    } else {
      console.log('  NAO TRIADOS: nenhum.');
    }
    if (velhos1.length) {
      console.log('\n  JA TRIADOS (nao contam como pendencia):');
      for (const s of velhos1) console.log(`  -- ${s.f}:${s.n}\n       ${s.l}\n       ${nota1(s.l)}`);
    }
  }
  console.log(`  (contra-prova: ${usosDoHelper} usos do helper em ${arquivosComHelper.size} arquivos)`);
}

// ─────────────────────────────────────────────── CLASSE 2
console.log('\n' + '='.repeat(74));
console.log('CLASSE 2 — forma de resposta/rota do Pagar.me herdada da v4');
console.log('='.repeat(74));
{
  const aninhados = [
    'waiting_funds?.amount', 'waiting_funds.amount',
    'available?.amount', 'available.amount',
    'transferred?.amount', 'transferred.amount',
  ];
  const r2a = [];
  for (const f of todos) {
    const linhas = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (let i = 0; i < linhas.length; i++) {
      if (/^\s*\*|^\s*\/\//.test(linhas[i])) continue;
      for (const a of aninhados) if (linhas[i].includes(a)) r2a.push(`${rel(f)}:${i + 1}  ->  ${a}`);
    }
  }
  console.log('\n 2a) leitura ANINHADA de campo de saldo (v5 e plano):');
  // TRIAGEM DE 15/10/2026: a unica ocorrencia e o FALLBACK deliberado do helper
  // `centavosAguardando`, que le o campo PLANO `waiting_funds_amount` da v5 e so
  // entao tenta a forma aninhada — para nao zerar em silencio se o provedor
  // variar a forma. Tem teste. Nao e heranca da v4; e defesa contra ela.
  const fallbackDoHelper = (x) => x.includes('payments/payments.service.ts') && x.includes('waiting_funds?.amount');
  const novos2a = r2a.filter((x) => !fallbackDoHelper(x));
  const velhos2a = r2a.filter(fallbackDoHelper);
  if (r2a.length === 0) console.log('   nenhuma');
  else {
    if (novos2a.length) { aConferir += novos2a.length; novos2a.forEach((x) => console.log('   !! ' + x)); }
    else console.log('   NAO TRIADOS: nenhum.');
    velhos2a.forEach((x) => console.log('   -- ' + x + '   (TRIADO: fallback deliberado do helper centavosAguardando, com teste)'));
  }

  const rotasV4 = [
    ['/anticipations`', 'v5 usa /bulk_anticipations'],
    ['/refund`', 'v5 usa DELETE /charges/{id}'],
    ['source_recipient_id', 'nao existe na v5'],
    ["'/transfers'", 'coletiva: 401 por allowlist; a por recebedor e SAQUE'],
  ];
  console.log('\n 2b) rota/campo da v4 dentro de uma CHAMADA:');
  const r2b = [];
  for (const f of todos) {
    const linhas = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (let i = 0; i < linhas.length; i++) {
      const l = linhas[i];
      if (/^\s*\*|^\s*\/\//.test(l)) continue;
      if (!/pagarme(Get|Post|Patch|Delete|Put)\(/.test(l)) continue;
      for (const [p, nota] of rotasV4) {
        if (l.includes(p)) r2b.push(`${rel(f)}:${i + 1}  (${nota})\n        ${l.trim()}`);
      }
    }
  }
  // TRIAGEM DE 15/10/2026: as ocorrencias de /transfers ja foram investigadas
  // (KAN-299). A rota coletiva responde 401 por allowlist de IP; a por recebedor
  // e SAQUE do saldo dele, nao empurrao da plataforma. Seguem listadas, e nao
  // apagadas, porque no dia em que o IP for liberado elas voltam a importar.
  const ehTransfer = (x) => x.includes("'/transfers'");
  const novos2b = r2b.filter((x) => !ehTransfer(x));
  const velhos2b = r2b.filter(ehTransfer);
  if (r2b.length === 0) console.log('   nenhuma');
  else {
    if (novos2b.length) { aConferir += novos2b.length; novos2b.forEach((x) => console.log('   !! ' + x)); }
    else console.log('   NAO TRIADOS: nenhum.');
    velhos2b.forEach((x) => console.log('   -- ' + x));
  }
}

// ─────────────────────────────────────────────── CLASSE 3
console.log('\n' + '='.repeat(74));
console.log("CLASSE 3 — HTTP 200 tratado como sucesso em caminho de dinheiro");
console.log('='.repeat(74));
{
  const marcasDeDinheiro = ['/capture', '/charges', '/transfers', 'bulk_anticipations', '/refund', '/paymentlinks'];
  const r3 = [];
  for (const f of todos) {
    const linhas = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (let i = 0; i < linhas.length; i++) {
      const l = linhas[i];
      if (/^\s*\*|^\s*\/\//.test(l)) continue;
      if (!/await this\.pagarme(Post|Delete|Patch)\(/.test(l)) continue;
      const trecho = linhas.slice(i, Math.min(linhas.length, i + 16)).join('\n');
      if (!marcasDeDinheiro.some((d) => l.includes(d) || trecho.slice(0, 260).includes(d))) continue;
      const atribui = /(const|let)\s+\w+\s*(:[^=]+)?=\s*await this\.pagarme/.test(l);
      const inspeciona = /last_transaction|estornarCobranca/.test(trecho);
      if (!atribui && !inspeciona) r3.push({ f: rel(f), n: i + 1, l: l.trim() });
    }
  }
  // TRIAGEM DE 15/10/2026.
  //
  // Sem isto, cada rodada reapresenta os mesmos pontos como se fossem novidade,
  // e quem rodar daqui a tres meses refaz a investigacao inteira — ou pior, le
  // como achado em aberto o que ja foi medido e descartado.
  //
  // Casa por TRECHO da linha, nao por numero de linha: numero envelhece a cada
  // edicao do arquivo e a anotacao passa a mentir sobre o ponto errado.
  const jaTriados = [
    [
      "'/transfers'",
      'TRIADO: repasse por transferencia. A rota coletiva responde 401 (allowlist de IP,' +
      ' KAN-299) e a por recebedor e SAQUE, nao empurrao da plataforma. O bloqueio de' +
      ' origem e reconhecido e o valor vira passivo em vez de retry por 48h (9a79460).',
    ],
    [
      '/capture`',
      'TRIADO E DESCARTADO POR MEDICAO: captura nao tem caminho silencioso. Toda falha' +
      ' que consegui produzir no sandbox volta como HTTP 412, que lanca e cai no' +
      ' try/catch — diferente do estorno, onde o 200 mascarando falha foi PROVADO.' +
      ' Ver scripts/provas/experimento-void-preauth.mjs.',
    ],
  ];
  const nota = (l) => (jaTriados.find(([p]) => l.includes(p)) || [])[1];

  const novos = r3.filter((s) => !nota(s.l));
  const velhos = r3.filter((s) => nota(s.l));

  if (r3.length === 0) {
    console.log('  Toda chamada de dinheiro tem o retorno atribuido ou inspecionado.');
  } else {
    if (novos.length) {
      aConferir += novos.length;
      console.log('  NAO TRIADOS:');
      for (const s of novos) console.log(`  ?? ${s.f}:${s.n}\n       ${s.l}`);
      console.log('\n  (?? = retorno nem atribuido nem inspecionado nas 16 linhas seguintes.');
      console.log('   Nao e automaticamente bug: ha chamada cujo 200 basta. Conferir uma a uma.)');
    } else {
      console.log('  NAO TRIADOS: nenhum.');
    }
    if (velhos.length) {
      console.log('\n  JA TRIADOS (nao contam como pendencia):');
      for (const s of velhos) console.log(`  -- ${s.f}:${s.n}\n       ${s.l}\n       ${nota(s.l)}`);
    }
  }
}

// ─────────────────────────────────────────────── CLASSE 4
console.log('\n' + '='.repeat(74));
console.log('CLASSE 4 — alias de palavra RESERVADA em SQL cru dentro do QueryBuilder');
console.log('='.repeat(74));
{
  // Esta classe entrou em 16/10/2026, depois de ela ter derrubado um scheduler
  // inteiro por dias.
  //
  // `.andWhere('order."codigoVendedor" IS NULL')` — alias cru com a coluna
  // entre aspas. O TypeORM so traduz e aspeia CAMINHO DE PROPRIEDADE
  // (`order.status`); SQL cru ele repassa como esta. E `order` e palavra
  // reservada, entao o Postgres respondia "syntax error at or near order"
  // (42601), a query lancava a cada rodada de 60s, o catch do scheduler
  // engolia, e o auto-confirm simplesmente deixou de existir.
  //
  // O gatilho e a COMBINACAO: alias reservado + SQL cru. Alias reservado com
  // caminho de propriedade e inofensivo, e SQL cru com alias nao-reservado
  // tambem. Por isso a heuristica procura as duas coisas juntas.
  const RESERVADAS = [
    'order', 'user', 'group', 'table', 'select', 'from', 'where',
    'limit', 'offset', 'end', 'all', 'check', 'default', 'desc', 'asc',
  ];
  const r4 = [];
  for (const f of todos) {
    const linhas = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (let i = 0; i < linhas.length; i++) {
      const l = linhas[i];
      if (/^\s*\*|^\s*\/\//.test(l)) continue; // comentario
      for (const r of RESERVADAS) {
        // alias reservado seguido de ponto e ASPAS: o jeito que quebra.
        if (new RegExp('\\b' + r + '\\."').test(l)) {
          r4.push({ f: rel(f), n: i + 1, l: l.trim(), alias: r });
          break;
        }
      }
    }
  }
  if (r4.length === 0) {
    console.log('  Nenhum. Nenhum alias reservado aparece colado a uma coluna entre aspas.');
    console.log(`  (aliases vigiados: ${RESERVADAS.join(', ')})`);
  } else {
    aConferir += r4.length;
    console.log('  NAO TRIADOS:');
    for (const s of r4) {
      console.log(`  !! ${s.f}:${s.n}  (alias "${s.alias}" e reservado)\n       ${s.l}`);
    }
    console.log('\n  Troque por caminho de propriedade (order.coluna) e deixe o TypeORM');
    console.log('  aspear. Isto NAO falha em teste: a query so quebra em runtime, e se');
    console.log('  estiver dentro de um scheduler, o catch dele engole e o job some.');
  }
}

console.log('\n' + '='.repeat(74));
// O numero so vale alguma coisa se distinguir "novo" de "ja investigado".
// Antes da triagem ele contava 11 pontos que eu ja tinha conferido um a um — um
// alarme que toca sempre e um alarme que ninguem escuta.
console.log(aConferir === 0
  ? 'RESULTADO: nada NOVO. O que a heuristica acusa ja foi investigado, e o porque\n           esta anotado em cada linha acima.'
  : `RESULTADO: ${aConferir} ponto(s) NAO TRIADOS acima — investigar.`);
console.log('='.repeat(74));
