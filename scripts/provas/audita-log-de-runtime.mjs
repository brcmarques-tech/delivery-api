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
const BENIGNOS = [
  ['WhatsApp desabilitado', 'WAHA não sobe na stack local; o aviso é do próprio guard do serviço'],
  ['ExponentPushToken', 'push de teste vai para o Expo e falha; cliente de teste não tem token real'],
  ['expo.io', 'mesma coisa: push para o Expo'],
  ['ECONNREFUSED 127.0.0.1:3001', 'WAHA local ausente'],
];

function logs(segundos) {
  return execSync(`docker logs ${CONTAINER} --since ${segundos}s 2>&1`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

console.log(`=== observando ${SEGUNDOS}s de log do container ${CONTAINER} ===`);
console.log('   (o scheduler roda a cada 60s; isto cobre pelo menos duas rodadas)\n');

// Espera sem sleep de shell: um curl com timeout longo contra uma rota que não
// existe. O 404 chega na hora, então uso o --max-time como cronômetro.
try {
  execSync(`curl -s --max-time ${SEGUNDOS} -o /dev/null http://localhost:3000/__espera_do_auditor__`, {
    encoding: 'utf8',
  });
} catch {
  // A espera acaba pelo timeout do curl. Não é erro.
}

const bruto = logs(SEGUNDOS + 10);
const linhas = bruto.split(/\r?\n/);

// O Nest colore o nível com escape ANSI; tiro antes de casar.
const limpo = (l) => l.replace(/\u001b\[[0-9;]*m/g, '');

const erros = linhas
  .map(limpo)
  .filter((l) => /\bERROR\b/.test(l) || /QueryFailedError|UnhandledPromiseRejection|syntax error at or near/.test(l));

const motivoBenigno = (l) => (BENIGNOS.find(([p]) => l.includes(p)) || [])[1];
const reais = erros.filter((l) => !motivoBenigno(l));
const tolerados = erros.filter((l) => motivoBenigno(l));

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
  console.log(`     ${linhas.length} linhas observadas em ${SEGUNDOS}s.`);
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
