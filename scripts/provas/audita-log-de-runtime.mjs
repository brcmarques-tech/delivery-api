// A API ESTÁ LOGANDO ERRO AGORA?
//
// Por que este script existe, e por que ele é a auditoria mais barata do
// repositório: em 15/10/2026 eu descobri que o scheduler de auto-confirmação
// estava LANÇANDO EM TODA RODADA de 60s, e havia dias.
//
// A linha culpada era `.andWhere('order."codigoVendedor" IS NULL')` — alias cru
// com a coluna entre aspas. `order` é palavra reservada em SQL, então o Postgres
// respondia "syntax error at or near order" (42601). O catch do scheduler
// engolia, e nenhum pedido era mais auto-confirmado. Nos pedidos SEM código
// (retirada, pagamento na entrega, loja com frota própria) esse job é o que paga
// vendedor e entregador quando o cliente nunca aperta "confirmar recebimento".
//
// Ela entrou junto com a feature de códigos e passou por:
//   - npx tsc --noEmit        (é string, compila)
//   - 111 testes unitários    (nenhum monta esse QueryBuilder contra Postgres)
//   - 3 suítes E2E            (dirigem a API por GraphQL; não leem o log)
//
// Nenhuma dessas ferramentas olha para o que a aplicação GRITA enquanto roda.
// Este script olha. É a diferença entre "compila e os testes passam" e "está
// funcionando".
//
// Uso:
//   node scripts/provas/audita-log-de-runtime.mjs [segundos]
//
// O padrão é 130s: o scheduler roda a cada 60s, então isso garante DUAS rodadas
// completas. Menos que uma rodada e o script não prova nada.
import { execSync } from 'node:child_process';

const SEGUNDOS = Math.max(70, Number(process.argv[2]) || 130);
const CONTAINER = 'shopping-api';

// Ruído esperado da stack LOCAL, que não indica defeito no código.
// Cada entrada precisa dizer POR QUE é benigna — senão esta lista vira o lugar
// onde um erro real se esconde.
//
// O terceiro campo, quando existe, é o LIMITE DE OCORRÊNCIAS. Acima dele a
// linha volta a contar como erro.
//
// Isso existe por causa do `[CODIGO_ERRADO]`, que é ERROR de propósito:
// tentativa repetida no código que libera dinheiro é evento de SEGURANÇA, e o
// serviço eleva o nível justamente para aparecer no monitoramento. Pôr na
// lista de benignos sem limite seria desligar esse alarme.
//
// Com limite, a distinção fica no lugar certo: algumas ocorrências são o E2E
// exercitando o bloqueio por força bruta de propósito; muitas são alguém
// tentando adivinhar código, ou uma tela mandando o valor errado em laço.
const BENIGNOS = [
  ['WhatsApp desabilitado', 'WAHA não sobe na stack local; o aviso é do próprio guard do serviço'],
  [
    'WhatsAppService] WhatsApp falhou',
    'timeout do WAHA. MAS LEIA O AVISO ABAIXO — o .env local aponta para o WAHA ' +
      'de PRODUÇÃO, e isso não é benigno, é só inofensivo enquanto ele está fora do ar',
  ],
  ['ExponentPushToken', 'push de teste vai para o Expo e falha; cliente de teste não tem token real'],
  ['expo.io', 'mesma coisa: push para o Expo'],
  ['ECONNREFUSED 127.0.0.1:3001', 'WAHA local ausente'],
  [
    '[CODIGO_ERRADO]',
    'o E2E dos códigos exercita o bloqueio por força bruta de propósito. ' +
      'ACIMA DO LIMITE deixa de ser benigno: é tentativa de adivinhar código, ' +
      'ou uma tela mandando valor errado em laço',
    8,
  ],
];

// ─────────────────────────────────────────────────────────────────────────────
// AVISO QUE NÃO É SOBRE ESTE SCRIPT, e sim sobre a configuração local.
//
// `WAHA_API_URL` no .env de desenvolvimento aponta para o WAHA de PRODUÇÃO
// (um IP público), não para `http://localhost:3003`, que é o default do
// serviço. Hoje as chamadas falham por timeout porque aquele WAHA está fora do
// ar — e é só por isso que o erro acima é inofensivo.
//
// No dia em que o WAHA voltar, rodar os E2E desta pasta vai DISPARAR MENSAGENS
// DE WHATSAPP DE VERDADE, pelo gateway de produção, para os telefones que os
// testes fabricam. Eles têm cara de número brasileiro.
//
// Correção de uma linha, no .env local:
//
//     WAHA_API_URL=http://localhost:3003
//
// Não fiz essa troca sozinho: é configuração do ambiente de quem desenvolve, e
// pode haver motivo para ela estar assim (testar integração contra o WAHA real,
// por exemplo). Fica registrado aqui, que é onde o erro aparece.
// ─────────────────────────────────────────────────────────────────────────────

function logs(segundos) {
  return execSync(`docker logs ${CONTAINER} --since ${segundos}s 2>&1`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

console.log(`=== observando ${SEGUNDOS}s de log do container ${CONTAINER} ===`);
console.log('   (o scheduler roda a cada 60s; isto cobre pelo menos duas rodadas)\n');

// A ESPERA DE VERDADE.
//
// A primeira versão fazia `curl -s --max-time 130` contra uma rota
// inexistente, com o comentário de que usava o `--max-time` como cronômetro.
// Não funciona: `--max-time` é TIMEOUT, não espera. A API responde 404 na
// hora, o curl volta em milissegundos, e o script seguia direto para a
// leitura do log.
//
// Ou seja: ele AFIRMAVA ter observado 130s — duas rodadas do scheduler — e
// observava zero. Lia o log que já existia naquele instante e dava OK. Por
// sorte as rodadas anteriores de E2E deixavam log suficiente para parecer
// que funcionava, e foi assim que ele passou o dia inteiro.
//
// Um auditor que mente sobre a janela que observou é pior que nenhum: ele
// transforma "não vi erro" em "não houve erro". Agora a espera é real, e o
// contador na tela mostra que o tempo está passando.
const esperarDeVerdade = (segundos) =>
  new Promise((resolve) => {
    const fim = Date.now() + segundos * 1000;
    const tick = () => {
      const faltam = Math.ceil((fim - Date.now()) / 1000);
      if (faltam <= 0) {
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
        return resolve();
      }
      process.stdout.write(`\r   observando... faltam ${faltam}s   `);
      setTimeout(tick, 1000);
    };
    tick();
  });

const inicio = Date.now();
await esperarDeVerdade(SEGUNDOS);
const observadoDeFato = Math.round((Date.now() - inicio) / 1000);

// Confere o próprio relógio: se a espera não aconteceu, o número não pode
// ser reportado como se tivesse acontecido.
if (observadoDeFato < SEGUNDOS - 5) {
  console.error(
    `ABORTADO: a janela de observação não foi cumprida (${observadoDeFato}s de ${SEGUNDOS}s). ` +
      `Reportar "nenhum erro" sem ter observado seria mentira.`,
  );
  process.exit(2);
}

const bruto = logs(SEGUNDOS + 10);
const linhas = bruto.split(/\r?\n/);

// O Nest colore o nível com escape ANSI; tiro antes de casar.
const limpo = (l) => l.replace(/\u001b\[[0-9;]*m/g, '');

const erros = linhas
  .map(limpo)
  .filter((l) => /\bERROR\b/.test(l) || /QueryFailedError|UnhandledPromiseRejection|syntax error at or near/.test(l));

const entradaBenigna = (l) => BENIGNOS.find(([p]) => l.includes(p));
const motivoBenigno = (l) => (entradaBenigna(l) || [])[1];

// O limite é por PADRÃO, não por linha: conta todas as ocorrências daquele
// padrão na janela e, se passar do teto, a entrada deixa de valer e TODAS as
// linhas dela voltam a ser erro. Contar por linha não serviria — cada
// `[CODIGO_ERRADO]` traz pedido e usuário diferentes, então nenhuma linha
// repete e o teto nunca seria alcançado.
const excedeuOTeto = (l) => {
  const entrada = entradaBenigna(l);
  const teto = entrada?.[2];
  // `typeof`, e não `!teto`: com `!teto` o teto ZERO — tolerância nenhuma —
  // seria lido como "sem teto" e a entrada nunca disparava. Peguei isso ao
  // testar a regra com 0 justamente para ver se ela disparava, e ela não
  // disparou. Um teto que eu não vi funcionar é um teto em que não confio.
  if (typeof teto !== 'number') return false;
  const quantas = erros.filter((x) => x.includes(entrada[0])).length;
  return quantas > teto;
};

const reais = erros.filter((l) => !motivoBenigno(l) || excedeuOTeto(l));
const tolerados = erros.filter((l) => motivoBenigno(l) && !excedeuOTeto(l));

// Agrupa por mensagem para não despejar a mesma linha 40 vezes.
function agrupar(ls) {
  const m = new Map();
  for (const l of ls) {
    // chave = a linha sem timestamp nem pid
    const chave = l.replace(/\d{1,2}\/\d{1,2}\/\d{4},?\s*[\d:]+\s*(AM|PM)?/g, '').replace(/\[Nest\]\s*\d+/g, '[Nest]').trim();
    m.set(chave, (m.get(chave) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

if (tolerados.length) {
  console.log(`--- ${tolerados.length} linha(s) de ruído conhecido da stack local ---`);
  for (const [l, n] of agrupar(tolerados)) {
    console.log(`   ${String(n).padStart(3)}x ${l.slice(0, 110)}`);
    console.log(`        (benigno: ${motivoBenigno(l)})`);
  }
  console.log('');
}

if (reais.length === 0) {
  console.log('OK   a API não logou nenhum erro nesta janela.');
  console.log(`     ${linhas.length} linhas observadas em ${observadoDeFato}s de observacao REAL.`);
  process.exit(0);
}

console.log(`FALHOU  ${reais.length} linha(s) de ERRO na janela observada:\n`);
for (const [l, n] of agrupar(reais)) {
  console.log(`  ${String(n).padStart(3)}x  ${l.slice(0, 160)}`);
}
console.log('\n  Erro que repete a cada ~60s é scheduler quebrado: ele lança, o catch');
console.log('  engole, e o job simplesmente deixa de acontecer. Foi exatamente assim');
console.log('  que o auto-confirm ficou dias sem rodar.');
process.exit(1);
