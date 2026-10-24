// O DEPLOY VAI SUBIR, OU A API VAI MORRER NO BOOT?
//
// ═══════════════════════════════════════════════════════════════════════════
// ESTE SCRIPT É SOMENTE LEITURA. Só executa SELECT. Não cria, não altera e não
// apaga nada — foi escrito para poder ser apontado para PRODUÇÃO sem susto.
// ═══════════════════════════════════════════════════════════════════════════
//
// POR QUE ELE EXISTE
//
// As migrations rodam no BOOT. Uma que falha não deixa só de aplicar: ela
// derruba a subida da API inteira. E duas das migrations deste projeto criam
// ÍNDICE ÚNICO:
//
//   UQ_coupons_code_store   em coupons (code, storeId)
//   UQ_app_users_cpf        em app_users (cpf)
//   UQ_vendor_users_cpf     em vendor_users (cpf)
//
// As três usam `CREATE UNIQUE INDEX IF NOT EXISTS`. O `IF NOT EXISTS` protege
// contra o índice já existir — NÃO contra o dado estar duplicado. Se houver
// duplicata, o Postgres responde "could not create unique index: Key is
// duplicated", a migration aborta, e a API não sobe. É o risco do KAN-283.
//
// O banco local não responde essa pergunta: ele não tem os dados de produção.
// Por isso o script aceita ser apontado para outro banco.
//
// COMO RODAR
//
//   local:
//     node scripts/provas/checa-prontidao-do-deploy.mjs
//
//   contra produção (leia o aviso acima antes):
//     DATABASE_URL="postgres://usuario:senha@host:5432/banco" \
//       node scripts/provas/checa-prontidao-do-deploy.mjs
//
// Sem DATABASE_URL ele fala com o Postgres do docker local.
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const URL_BANCO = process.env.DATABASE_URL || '';
const problemas = [];
const avisos = [];

// Executa SELECT. Duas formas: psql dentro do container (local) ou o cliente
// `pg` do projeto contra uma URL (produção).
let consultar;
if (URL_BANCO) {
  const { default: pg } = await import('pg');
  const cliente = new pg.Client({
    connectionString: URL_BANCO,
    ssl: /sslmode=require|amazonaws|rds/.test(URL_BANCO) ? { rejectUnauthorized: false } : undefined,
  });
  await cliente.connect();
  consultar = async (sql) => (await cliente.query(sql)).rows;
  process.on('exit', () => { try { cliente.end(); } catch {} });
  const alvo = URL_BANCO.replace(/\/\/[^@]*@/, '//<credenciais>@');
  console.log(`=== banco: ${alvo} ===\n`);
} else {
  // `-tA` já separa campos por "|" no modo não-alinhado. A primeira versão
  // passava `-F'|'` explícito e quebrava no Windows: o execSync vai pelo
  // cmd.exe, que não tira as aspas simples, e o psql recebia um separador
  // literal `'|'`. O script falhou FECHADO — reportou "não consegui ler" em
  // vez de dar OK sobre nada —, que é o comportamento certo para uma
  // verificação de deploy, mas o comando estava errado mesmo assim.
  consultar = async (sql) => {
    const saida = execSync(
      `docker exec shopping-postgres psql -U shopping -d shopping_db -tA -c "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { encoding: 'utf8' },
    ).trim();
    if (!saida) return [];
    return saida.split('\n').map((l) => ({ _: l.split('|') }));
  };
  console.log('=== banco: shopping_db local (docker) ===\n');
}

const valor = (linha) => (Array.isArray(linha._) ? linha._ : Object.values(linha));

// ═══════════════════════════════ 1. migrations pendentes
console.log('1. MIGRATIONS QUE O DEPLOY VAI APLICAR');

const noRepo = fs
  .readdirSync(path.join(RAIZ_API, 'src/migrations'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({
    arquivo: f,
    classe: (fs.readFileSync(path.join(RAIZ_API, 'src/migrations', f), 'utf8').match(/export class (\w+)/) || [])[1],
  }))
  .filter((m) => m.classe);

let registradas = [];
try {
  registradas = (await consultar('SELECT name FROM migrations')).map((r) => String(valor(r)[0]).trim());
} catch {
  problemas.push('não consegui ler a tabela `migrations` — o banco já foi inicializado?');
}

const pendentes = noRepo.filter((m) => !registradas.includes(m.classe));
if (pendentes.length === 0) {
  console.log('   nenhuma. O banco já está no ponto do código.\n');
} else {
  pendentes.forEach((m) => console.log('   - ' + m.arquivo));
  console.log('');
}

// ═══════════════════════════════ 2. duplicatas que abortam o boot
//
// Só interessa checar o índice cuja migration AINDA NÃO RODOU: se já rodou, o
// índice existe e o banco já estava limpo.
console.log('2. DADO DUPLICADO QUE FARIA A MIGRATION ABORTAR O BOOT');

const indices = [
  {
    migration: 'AddCouponCodeStoreUnique',
    rotulo: 'cupons com o MESMO código na MESMA loja',
    // SEM filtro de soft-delete: `coupons` não tem `deletedAt`. A primeira
    // versão filtrava por ele e a checagem morria com "column does not exist"
    // — virava um aviso, não um OK falso, mas a verificação que importa
    // simplesmente não acontecia. E é a mesma verdade para o Postgres: o
    // índice único conta TODAS as linhas da tabela, soft-delete ou não.
    sql: `SELECT code, "storeId", count(*) FROM coupons GROUP BY code, "storeId" HAVING count(*) > 1`,
    conserto: 'apagar ou renomear os cupons repetidos antes de subir',
  },
  {
    migration: 'CpfUnicoESessaoAtiva',
    rotulo: 'clientes com o MESMO CPF',
    // A migration NORMALIZA o CPF (tira pontuação) ANTES de criar o índice.
    // Então a duplicata que importa é a dos dígitos, não a do texto: "111.111"
    // e "111111" são o mesmo CPF depois da normalização, e só colidem ali.
    sql: `SELECT regexp_replace(cpf,'\\D','','g') AS d, count(*) FROM app_users WHERE cpf IS NOT NULL AND regexp_replace(cpf,'\\D','','g') <> '' GROUP BY 1 HAVING count(*) > 1`,
    conserto: 'resolver os cadastros duplicados antes de subir',
  },
  {
    migration: 'CpfUnicoESessaoAtiva',
    rotulo: 'lojistas com o MESMO CPF',
    sql: `SELECT regexp_replace(cpf,'\\D','','g') AS d, count(*) FROM vendor_users WHERE cpf IS NOT NULL AND regexp_replace(cpf,'\\D','','g') <> '' GROUP BY 1 HAVING count(*) > 1`,
    conserto: 'resolver os cadastros duplicados antes de subir',
  },
];

for (const idx of indices) {
  const jaRodou = !pendentes.some((p) => p.arquivo.includes(idx.migration));
  if (jaRodou) {
    console.log(`   ok   ${idx.rotulo} — a migration ${idx.migration} já rodou neste banco`);
    continue;
  }
  let linhas;
  try {
    linhas = await consultar(idx.sql);
  } catch (e) {
    avisos.push(`não consegui checar "${idx.rotulo}": ${String(e.message).split('\n')[0]}`);
    continue;
  }
  if (linhas.length === 0) {
    console.log(`   ok   nenhum caso de ${idx.rotulo}`);
  } else {
    console.log(`   !!   ${linhas.length} caso(s) de ${idx.rotulo}`);
    linhas.slice(0, 10).forEach((l) => console.log('          ' + valor(l).join(' | ')));
    if (linhas.length > 10) console.log(`          ... e outros ${linhas.length - 10}`);
    problemas.push(
      `${linhas.length} caso(s) de ${idx.rotulo}: a migration ${idx.migration} vai ABORTAR O BOOT. ${idx.conserto}`,
    );
  }
}
console.log('');

// ═══════════════════════════════ 3. variáveis de ambiente
//
// Só checa o ambiente de ONDE o script roda. Numa máquina de desenvolvimento
// isso não diz nada sobre o servidor — por isso o texto avisa.
console.log('3. VARIÁVEIS DE AMBIENTE DESTE PROCESSO');

const flags = [
  {
    nome: 'APP_DELIVERY_REQUIRES_CARD',
    deveEstar: 'ausente',
    porque:
      'o padrão (ausente) é ON, que é o estado SEGURO: entrega por app exige cartão ' +
      'enquanto não existir PIX-out. O compose local põe "false" só para o E2E. ' +
      'Em produção, "false" libera entrega por app sem garantia de pagamento ao entregador.',
  },
  {
    nome: 'DELIVERY_CODES_ENABLED',
    deveEstar: 'ausente',
    porque:
      'o padrão (ausente) é ON. Pôr "false" desliga a GERAÇÃO de códigos em pedidos NOVOS — ' +
      'pedido já criado não é afetado, e os apps caem no fluxo antigo para eles.',
  },
  {
    nome: 'DELIVERY_NO_CODE_DISPUTE_HOURS',
    deveEstar: 'opcional',
    porque:
      'janela de contestação da entrega sem código. Ausente = 24h. O aviso enviado ao ' +
      'cliente usa este mesmo valor, então mudá-lo não dessincroniza a mensagem.',
  },
  {
    nome: 'WAHA_API_URL',
    deveEstar: 'opcional',
    porque:
      'em DESENVOLVIMENTO deve ser http://localhost:3003. Apontado para o WAHA de ' +
      'produção, rodar os E2E dispara WhatsApp de verdade para telefones de teste.',
  },
];

for (const f of flags) {
  const v = process.env[f.nome];
  const presente = v !== undefined && v !== '';
  const marca = f.deveEstar === 'ausente' && presente ? '!!' : 'ok';
  console.log(`   ${marca}   ${f.nome} = ${presente ? JSON.stringify(v) : '(ausente)'}`);
  if (marca === '!!') {
    avisos.push(`${f.nome} está definida como ${JSON.stringify(v)}. ${f.porque}`);
  }
}
console.log('\n   (isto reflete o ambiente de QUEM RODA o script, não o do servidor.');
console.log('    No servidor, confira as mesmas variáveis no ambiente da API.)\n');

// ═══════════════════════════════ 4. colunas que o código novo exige
//
// A migration pode estar pendente E o deploy ser feito sem rodá-la — ja
// aconteceu neste projeto de o synchronize estar desligado e nao haver caminho
// de migration nenhum (KAN-261). Entao confiro as colunas DIRETO no schema.
console.log('4. COLUNAS QUE O CÓDIGO ATUAL EXIGE');

const exigidas = [
  ['orders', 'codigoVendedor', 'garantia de entrega por códigos'],
  ['orders', 'codigoCliente', 'garantia de entrega por códigos'],
  ['orders', 'entregaSemCodigoEm', 'entrega sem código / janela de contestação'],
  ['orders', 'delivererPayableCents', 'passivo do entregador'],
  ['orders', 'vendorPayableCents', 'passivo do lojista (repasse bloqueado)'],
];

for (const [tabela, coluna, paraQue] of exigidas) {
  let existe = false;
  try {
    const r = await consultar(
      `SELECT 1 FROM information_schema.columns WHERE table_name='${tabela}' AND column_name='${coluna}'`,
    );
    existe = r.length > 0;
  } catch (e) {
    avisos.push(`não consegui checar ${tabela}.${coluna}: ${String(e.message).split('\n')[0]}`);
    continue;
  }
  console.log(`   ${existe ? 'ok  ' : '!!  '} ${tabela}.${coluna}  (${paraQue})`);
  if (!existe) {
    problemas.push(
      `${tabela}.${coluna} NÃO existe. O código atual escreve nessa coluna: sem ela, ` +
        `${paraQue} quebra em runtime.`,
    );
  }
}

// ═══════════════════════════════ veredito
console.log('\n' + '='.repeat(74));
if (avisos.length) {
  console.log('AVISOS:');
  avisos.forEach((a) => console.log('  ~ ' + a));
  console.log('');
}
if (problemas.length === 0) {
  console.log('PRONTO. Nada que faça o boot abortar.');
  if (pendentes.length) {
    console.log(`O deploy vai aplicar ${pendentes.length} migration(s) — listadas acima.`);
  }
  process.exit(0);
}
console.log(`NÃO SUBIR AINDA — ${problemas.length} problema(s):`);
problemas.forEach((p) => console.log('  ! ' + p));
console.log('\nMigration que falha no boot não deixa só de aplicar: derruba a subida');
console.log('da API inteira.');
process.exit(1);
