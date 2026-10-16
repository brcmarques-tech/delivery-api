// O verificador de deploy PEGA o problema, ou só sabe dizer "tudo bem"?
//
// Monta num banco descartável o cenário exato do KAN-283: migrations de índice
// único pendentes E dado duplicado. Se o verificador disser "PRONTO" aí, ele
// não serve para nada.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// scripts/provas/<este arquivo> -> a raiz da API e dois niveis acima.
const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CLONE = 'ensaio_prontidao';
const dentro = (cmd, db = 'postgres') =>
  execSync(`docker exec shopping-postgres psql -U shopping -d ${db} -tA -c "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

try {
  console.log('=== montando o cenario ruim num banco descartavel ===');
  dentro(`DROP DATABASE IF EXISTS ${CLONE}`);
  dentro(`CREATE DATABASE ${CLONE} OWNER shopping`);
  sh(`docker exec shopping-postgres sh -c "pg_dump -U shopping --schema-only shopping_db | psql -U shopping -d ${CLONE} -q"`);
  // Copia os DADOS inteiros, nao tabela a tabela. A primeira versao trazia so
  // migrations+stores+app_users e o COPY de stores falhava por FK com
  // vendor_users, que eu nao tinha copiado — e o 2>/dev/null escondia o erro.
  // Banco de desenvolvimento e pequeno; acertar a ordem de dependencia a mao
  // nao vale o risco de esconder outra falha.
  sh(`docker exec shopping-postgres sh -c "pg_dump -U shopping --data-only shopping_db | psql -U shopping -d ${CLONE} -q"`);

  // Finge que as duas migrations de indice unico nunca rodaram, e derruba os
  // indices que elas criam.
  dentro(`DELETE FROM migrations WHERE name LIKE '%AddCouponCodeStoreUnique%' OR name LIKE '%CpfUnicoESessaoAtiva%'`, CLONE);
  // Alguns desses indices sao sustentados por CONSTRAINT, e dai o DROP INDEX
  // e recusado ("constraint ... requires it"). Tenta a constraint primeiro.
  for (const [tabela, i] of [['coupons','UQ_coupons_code_store'],['app_users','UQ_app_users_cpf'],['vendor_users','UQ_vendor_users_cpf']]) {
    try { dentro(`ALTER TABLE "${tabela}" DROP CONSTRAINT IF EXISTS "${i}"`, CLONE); } catch {}
    try { dentro(`DROP INDEX IF EXISTS "${i}"`, CLONE); } catch {}
  }

  // E semeia a duplicata que faria o CREATE UNIQUE INDEX falhar.
  const loja = dentro('SELECT id FROM stores LIMIT 1', CLONE);
  if (!loja) throw new Error('o banco de referencia nao tem loja nenhuma');
  dentro(
    `INSERT INTO coupons (code, "discountType", "discountValue", "maxUses", "usesCount", "isActive", "storeId") ` +
    `VALUES ('DUPLICADO','FIXED',5,0,0,true,'${loja}'), ('DUPLICADO','FIXED',5,0,0,true,'${loja}')`,
    CLONE,
  );
  // CPF repetido em dois clientes, em formatos DIFERENTES: a migration
  // normaliza antes de indexar, entao "111.444.777-35" e "11144477735" colidem.
  // Se o verificador comparasse o texto cru, nao veria esta duplicata.
  const ids = dentro('SELECT id FROM app_users ORDER BY "createdAt" LIMIT 2', CLONE).split('\n');
  if (ids.length < 2) throw new Error('o banco de referencia nao tem dois clientes');
  dentro(`UPDATE app_users SET cpf='111.444.777-35' WHERE id='${ids[0].trim()}'`, CLONE);
  dentro(`UPDATE app_users SET cpf='11144477735'    WHERE id='${ids[1].trim()}'`, CLONE);

  console.log('   2 cupons com o mesmo codigo na mesma loja');
  console.log('   2 clientes com o mesmo CPF, em formatos diferentes');
  console.log('   migrations de indice unico marcadas como pendentes\n');

  // O verificador, apontado para o clone.
  const url = `postgres://shopping:teste123@localhost:5432/${CLONE}`;
  let saida = '', codigo = 0;
  try {
    saida = execSync('node scripts/provas/checa-prontidao-do-deploy.mjs', {
      cwd: RAIZ_API,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url },
    });
  } catch (e) {
    saida = (e.stdout || '') + (e.stderr || '');
    codigo = e.status ?? 1;
  }
  console.log(saida);

  // ASSERTIVAS PRECISAS.
  //
  // A primeira versão checava `/!!/` em qualquer lugar da saída, e por isso
  // deu OK no cupom mesmo quando aquela verificação NEM CHEGOU A RODAR — a
  // query morria com "column deletedAt does not exist" e virava um aviso.
  // Uma assertiva frouxa num provador é pior que nenhuma: ela certifica.
  //
  // Agora cada uma exige o SEU caso na lista de problemas, e `semAvisoDeFalha`
  // reprova se qualquer verificação deixou de rodar.
  const problemaCom = (termo) =>
    saida.split('\n').some((l) => l.trim().startsWith('!') && l.includes(termo));
  const pegouCupom = problemaCom('cupons com o MESMO c');
  const pegouCpf = problemaCom('clientes com o MESMO CPF');
  const reprovou = /NAO SUBIR AINDA|NÃO SUBIR AINDA/.test(saida);
  const semAvisoDeFalha = !/consegui checar/.test(saida);

  console.log('='.repeat(74));
  console.log((pegouCupom ? 'OK  ' : 'FALHOU ') + 'acusou os cupons duplicados');
  console.log((pegouCpf ? 'OK  ' : 'FALHOU ') + 'acusou o CPF duplicado em formatos diferentes');
  console.log((reprovou ? 'OK  ' : 'FALHOU ') + 'reprovou o deploy');
  console.log((codigo !== 0 ? 'OK  ' : 'FALHOU ') + 'saiu com codigo de erro (' + codigo + ')');
  console.log((semAvisoDeFalha ? 'OK  ' : 'FALHOU ') + 'nenhuma verificacao deixou de rodar');

  if (!(pegouCupom && pegouCpf && reprovou && codigo !== 0 && semAvisoDeFalha)) process.exit(1);
} finally {
  try { dentro(`DROP DATABASE IF EXISTS ${CLONE} WITH (FORCE)`); console.log(`\n(banco ${CLONE} apagado)`); }
  catch { console.log(`\n!! apague a mao: DROP DATABASE ${CLONE};`); }
}
