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

  if (suspeitos.length === 0) {
    console.log('  Nenhuma. Todo claim de escrita decide por linhasAfetadas/claimGanho.');
  } else {
    aConferir += suspeitos.length;
    for (const s of suspeitos) console.log(`  !! ${s.f}:${s.n}\n       ${s.l}`);
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
  if (r2a.length === 0) console.log('   nenhuma');
  else { aConferir += r2a.length; r2a.forEach((x) => console.log('   !! ' + x)); }

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
  if (r2b.length === 0) console.log('   nenhuma');
  else { aConferir += r2b.length; r2b.forEach((x) => console.log('   !! ' + x)); }
}

// ─────────────────────────────────────────────── CLASSE 3
console.log('\n' + '='.repeat(74));
console.log('CLASSE 3 — HTTP 200 tratado como sucesso em caminho de dinheiro');
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
  if (r3.length === 0) {
    console.log('  Toda chamada de dinheiro tem o retorno atribuido ou inspecionado.');
  } else {
    aConferir += r3.length;
    for (const s of r3) console.log(`  ?? ${s.f}:${s.n}\n       ${s.l}`);
    console.log('\n  (?? = retorno nem atribuido nem inspecionado nas 16 linhas seguintes.');
    console.log('   Nao e automaticamente bug: ha chamada cujo 200 basta. Conferir uma a uma.)');
  }
}

console.log('\n' + '='.repeat(74));
console.log(aConferir === 0
  ? 'RESULTADO: nenhuma ocorrencia das tres classes.'
  : `RESULTADO: ${aConferir} ponto(s) a conferir acima.`);
console.log('='.repeat(74));
