// AUDITORIA DO CAMINHO INTEIRO, EM UM COMANDO.
//
//   node scripts/provas/audita-caminho-completo.mjs
//
// Roda a bateria toda — estáticas, testes, E2E e provas de concorrência — e
// devolve UM veredito. Serve para responder "o caminho está íntegro?" sem
// ninguém ter de lembrar quais são os doze scripts nem em que ordem.
//
// ─── POR QUE ELE EXISTE, e não é só um `for` num shell ───────────────────────
//
// O rate limit da API é de 120 requisições por 60s (ThrottlerModule no
// app.module). Cada E2E gasta 20 a 40 entre cadastros e logins, então rodar
// os scripts em fila estoura a cota e eles começam a falhar com "throttle
// persistente" — uma falha do ARRANJO, não do produto, que é exatamente o
// tipo de ruído que faz uma suíte perder credibilidade.
//
// Por isso o runner espera a janela do limitador fechar entre um script e
// outro. A pausa vem do TTL real (60s) com margem, não de um chute.
//
// As verificações ESTÁTICAS (varredura de classes de bug, validação de
// GraphQL, prontidão de deploy) não gastam cota e rodam em sequência direta.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_API = path.resolve(AQUI, '..', '..');

// TTL do ThrottlerModule + margem. Se o limite mudar lá, mude aqui.
const PAUSA_MS = Number(process.env.AUDITORIA_PAUSA_MS) || 65_000;

const SO_ESTATICAS = process.argv.includes('--estaticas');

/**
 * Cada etapa diz se CONSOME COTA da API. Só as que consomem precisam da
 * pausa entre si — as estáticas leem arquivos e banco direto.
 */
const ETAPAS = [
  // ── estáticas: nada de API ──────────────────────────────────────────────
  { nome: 'testes unitários', cmd: 'npx jest', cota: false, extrai: /Tests:\s+(.+)/ },
  { nome: 'classes de bug (4 varreduras)', script: 'audita-classes-de-bug.mjs', cota: false },
  { nome: 'GraphQL dos apps x schema', script: 'valida-graphql-dos-apps.mjs', cota: false },
  { nome: 'prontidão de deploy', script: 'checa-prontidao-do-deploy.mjs', cota: false },
  { nome: 'migrations ensaiadas', script: 'ensaia-migration-codigos.mjs', cota: false },
  { nome: 'migration dos códigos (texto)', script: 'audita-migration-codigos.mjs', cota: false },
  { nome: 'preço de propaganda', script: 'prova-promocoes-preco.mjs', cota: false },
  { nome: 'baseline do schema (banco vazio)', script: 'ensaia-baseline-do-schema.mjs', cota: false },

  // ── o caminho, pela API ─────────────────────────────────────────────────
  { nome: 'CAMINHO COMPLETO (loja → dinheiro)', script: 'e2e-caminho-completo.mjs', cota: true },
  { nome: 'fluxo de compra', script: 'e2e-fluxo-compra.mjs', cota: true },
  { nome: 'entrega por códigos', script: 'e2e-codigos-entrega.mjs', cota: true },
  { nome: 'entrega sem código (janela)', script: 'e2e-entrega-sem-codigo.mjs', cota: true },
  { nome: 'pedido legado (deploy em trânsito)', script: 'e2e-pedido-legado-sem-codigo.mjs', cota: true },
  { nome: 'estoque em concorrência', script: 'prova-estoque-concorrencia.mjs', cota: true },
  { nome: 'cupom em concorrência', script: 'prova-cupom-maxuses.mjs', cota: true },
  { nome: 'aviso antes do bloqueio', script: 'prova-aviso-de-bloqueio.mjs', cota: true },
  { nome: 'checkout do site: PIX e cartão', script: 'prova-checkout-web-pagamento.mjs', cota: true },
  { nome: 'frete mostrado x cobrado', script: 'prova-frete-mostrado-x-cobrado.mjs', cota: true },
  { nome: 'painel financeiro fecha a conta', script: 'prova-painel-financeiro.mjs', cota: true },
  { nome: 'cliente fiel (prêmio não vaza)', script: 'prova-cliente-fiel.mjs', cota: true },
  { nome: 'contas de equipe (sem IDOR entre lojas)', script: 'prova-contas-de-equipe.mjs', cota: true },
  { nome: 'visual da loja (vitrine legível)', script: 'prova-visual-da-loja.mjs', cota: true },
  { nome: 'agente do WhatsApp', script: 'prova-agente-n8n.mjs', cota: true },
  { nome: 'busca: promoção aparece', script: 'prova-busca-promocao-no-app.mjs', cota: false },
  // Esta precisa do SITE rodando (next dev). Quando ele não está no ar o
  // script sai com código 2 e a etapa aparece como PULADA — melhor que uma
  // falha vermelha que não é do produto.
  { nome: 'sessão do site (token fora do JS)', script: 'prova-sessao-do-site.mjs', cota: true, pulaSe: 2 },

  // ── por último: o log, para pegar o que as outras deixaram no caminho ───
  { nome: 'log de runtime (130s)', script: 'audita-log-de-runtime.mjs', cota: false },
];

// Só uso `\r` para reescrever a linha quando a saída é um TERMINAL.
//
// Canalizada (`| tail`, redirecionada para arquivo, lida por outro script), a
// volta de carro não limpa nada: ela vira caractere no meio do texto e come os
// rótulos das etapas seguintes. Foi o que aconteceu na primeira execução — o
// resultado estava certo e o relatório, ilegível: as sete etapas de API
// apareceram como números soltos, sem nome.
//
// Relatório que não se lê é meia ferramenta, e numa auditoria a metade que
// falta é justamente a que diz O QUE passou.
const ehTerminal = !!process.stdout.isTTY;
const progresso = (texto) => {
  if (ehTerminal) process.stdout.write(`\r${texto}   `);
};
const limparLinha = () => {
  if (ehTerminal) process.stdout.write(`\r${' '.repeat(60)}\r`);
};

const esperar = (ms) =>
  new Promise((r) => {
    const fim = Date.now() + ms;
    const tick = () => {
      const faltam = Math.ceil((fim - Date.now()) / 1000);
      if (faltam <= 0) {
        limparLinha();
        return r();
      }
      progresso(`   aguardando a janela do rate limit: ${faltam}s`);
      setTimeout(tick, 1000);
    };
    // Fora do terminal, avisa UMA vez em vez de ficar mudo por 65s.
    if (!ehTerminal) console.log(`   (aguardando ${Math.round(ms / 1000)}s pela janela do rate limit)`);
    tick();
  });

function rodar(etapa) {
  const cmd = etapa.cmd || `node ${path.join('scripts', 'provas', etapa.script)}`;
  try {
    // `2>&1` no próprio comando: o jest escreve o resumo ("Tests: 176
    // passed") no STDERR, e sem isso o runner pegava a última linha do stdout
    // — que era um log do Nest — e a reportava como se fosse o resultado.
    const saida = execSync(`${cmd} 2>&1`, {
      cwd: RAIZ_API,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, saida, codigo: 0 };
  } catch (e) {
    return { ok: false, saida: (e.stdout || '') + (e.stderr || ''), codigo: e.status ?? 1 };
  }
}

/** A linha de resultado de cada script, para o relatório ficar legível. */
function resumo(etapa, saida) {
  if (etapa.extrai) {
    const m = saida.match(etapa.extrai);
    if (m) return m[1].trim();
  }
  const linhas = saida.split(/\r?\n/).filter(Boolean);
  const alvo = [...linhas].reverse().find((l) =>
    /OK, \d+ FALHOU|RESULTADO:|\d+ ok, \d+ falha|nenhuma operacao divergente|nao logou nenhum erro|PRONTO|NAO SUBIR/.test(l),
  );
  return (alvo || linhas[linhas.length - 1] || '').replace(/[═=]/g, '').trim().slice(0, 72);
}

console.log('═'.repeat(76));
console.log('AUDITORIA DO CAMINHO: loja → produto → propaganda → compra → split → entrega');
console.log('═'.repeat(76));
if (SO_ESTATICAS) console.log('(modo --estaticas: só o que não consome cota da API)\n');

const resultados = [];
let primeiraComCota = true;

for (const etapa of ETAPAS) {
  if (SO_ESTATICAS && etapa.cota) continue;

  // A pausa vai ANTES da etapa que consome cota, exceto na primeira delas —
  // ali a cota ainda está cheia.
  if (etapa.cota && !primeiraComCota) await esperar(PAUSA_MS);
  if (etapa.cota) primeiraComCota = false;

  limparLinha();
  process.stdout.write(`▶ ${etapa.nome} ... `);
  const t0 = Date.now();
  const r = rodar(etapa);
  const seg = ((Date.now() - t0) / 1000).toFixed(0);
  const linha = resumo(etapa, r.saida);
  // Pré-condição de ambiente ausente (ex.: o site não está rodando) não é
  // falha do produto: a etapa é PULADA e o relatório diz por quê.
  const pulada = etapa.pulaSe != null && r.codigo === etapa.pulaSe;
  console.log(`${pulada ? 'PULADA' : r.ok ? 'OK' : 'FALHOU'} (${seg}s)`);
  if (linha) console.log(`   ${linha}`);
  if (pulada) {
    resultados.push({ nome: etapa.nome, ok: true, pulada: true, linha });
    continue;
  }
  if (!r.ok) {
    // Só as linhas que ajudam: a asserção que falhou, não o dump inteiro.
    const pistas = r.saida
      .split(/\r?\n/)
      .filter((l) => /❌|FALHOU|!! |Error:|falha/i.test(l))
      .slice(0, 6);
    pistas.forEach((p) => console.log(`   │ ${p.trim().slice(0, 100)}`));
  }
  resultados.push({ nome: etapa.nome, ok: r.ok, linha });
}

limparLinha();
console.log('\n' + '═'.repeat(76));
const falharam = resultados.filter((r) => !r.ok);
console.log(`${resultados.length - falharam.length} de ${resultados.length} etapas OK`);
if (falharam.length === 0) {
  console.log('\nCAMINHO ÍNTEGRO. Nenhuma etapa da auditoria acusou problema.');
  process.exit(0);
}
console.log(`\n${falharam.length} etapa(s) com problema:`);
falharam.forEach((r) => console.log(`  ! ${r.nome} — ${r.linha}`));
console.log('\nRode a etapa sozinha para ver o detalhe:');
console.log('  node scripts/provas/<script>.mjs');
process.exit(1);
