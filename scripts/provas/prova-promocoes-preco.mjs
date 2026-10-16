// A PROPAGANDA DEFINE O PREÇO DE VENDA. ELA DEFINE QUAL?
//
// `orders.service.ts` calcula o subtotal com `product.promotionalPrice ||
// product.price`. Quem escreve `promotionalPrice` são dois schedulers do
// módulo de promoções: um ATIVA campanhas pagas cuja janela começou, o outro
// LIMPA o preço quando a janela acaba.
//
// Ou seja: esses dois UPDATEs decidem por quanto o produto é vendido, e
// portanto a base da comissão e a fatia de cada um no split. Vale olhar para
// eles com o mesmo rigor do split.
//
// Este script roda o SQL EXATO dos dois schedulers contra um banco
// descartável, com cenários montados à mão. Não toca no shopping_db.
//
// As duas perguntas:
//
//   1. Duas campanhas pagas e ativas no MESMO produto, com preços
//      diferentes e janelas sobrepostas — qual preço vale? O `create` só
//      limita a QUANTIDADE por semana (cota do plano); não há nada que
//      impeça duas no mesmo produto.
//
//   2. Uma campanha vencida (preço aplicado) e outra paga mas DESLIGADA
//      pelo lojista, com janela futura — o preço vencido é limpo? O guarda
//      do NOT EXISTS confere `isPaid`, mas não `isActive`.
import { execSync } from 'node:child_process';

const CLONE = 'ensaio_promocoes';
const ok = [], achados = [];
const check = (c, n, d = '') => { (c ? ok : achados).push(n); console.log(`${c ? 'OK  ' : '>>  '} ${n}${d ? ' — ' + d : ''}`); };

const q = (sql, db = CLONE) =>
  execSync(
    `docker exec shopping-postgres psql -U shopping -d ${db} -tA -c "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
    { encoding: 'utf8' },
  ).trim();
const adm = (sql) => q(sql, 'postgres');
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

// O SQL EXATO dos dois schedulers (promotions.service.ts). Copiado, não
// reescrito: um teste contra uma versão "equivalente" da query não prova nada
// sobre a que roda em produção.
const SQL_ATIVAR = `
  UPDATE products p
  SET "promotionalPrice" = vigente."promotionalPrice"
  FROM (
    SELECT DISTINCT ON (pr."productId")
           pr."productId",
           pr."promotionalPrice"
      FROM promotions pr
     WHERE pr."isPaid" = true AND pr."isActive" = true AND pr."startDate" <= NOW() AND pr."endDate" >= NOW() AND pr."promotionalPrice" IS NOT NULL
     ORDER BY pr."productId", pr."startDate" DESC, pr."createdAt" DESC
  ) vigente
  WHERE vigente."productId" = p.id
    AND p."promotionalPrice" IS DISTINCT FROM vigente."promotionalPrice"`;

const SQL_LIMPAR = `
  UPDATE products p
  SET "promotionalPrice" = NULL
  WHERE p."promotionalPrice" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM promotions pr
       WHERE pr."productId" = p.id
         AND pr."isPaid" = true AND pr."isActive" = true AND pr."startDate" <= NOW() AND pr."endDate" >= NOW() AND pr."promotionalPrice" IS NOT NULL
    )`;

let criado = false;
try {
  adm(`DROP DATABASE IF EXISTS ${CLONE}`);
  adm(`CREATE DATABASE ${CLONE} OWNER shopping`);
  criado = true;
  sh(`docker exec shopping-postgres sh -c "pg_dump -U shopping --schema-only shopping_db | psql -U shopping -d ${CLONE} -q"`);
  sh(`docker exec shopping-postgres sh -c "pg_dump -U shopping --data-only shopping_db | psql -U shopping -d ${CLONE} -q"`);

  const loja = q('SELECT id FROM stores LIMIT 1');
  const categoria = q(`SELECT id FROM categories WHERE "storeId"='${loja}' LIMIT 1`)
    || q('SELECT id FROM categories LIMIT 1');
  if (!loja) throw new Error('o banco de referencia nao tem loja');

  const novoProduto = (nome, preco) => {
    q(
      `INSERT INTO products (name, price, stock, "isAvailable", "storeId", "categoryId") ` +
      `VALUES ('${nome}', ${preco}, 100, true, '${loja}', ` +
      (categoria ? `'${categoria}'` : 'NULL') + `)`,
    );
    return q(`SELECT id FROM products WHERE name='${nome}' ORDER BY "createdAt" DESC LIMIT 1`);
  };

  const novaPromo = (produto, preco, inicio, fim, { paga = true, ativa = true } = {}) => {
    q(
      `INSERT INTO promotions (title, "startDate", "endDate", "isActive", "promotionalPrice", "isPaid", price, "storeId", "productId") ` +
      `VALUES ('promo', ${inicio}, ${fim}, ${ativa}, ${preco}, ${paga}, 0, '${loja}', '${produto}')`,
    );
  };

  // ═══════════════════════════ CENÁRIO 1: duas campanhas no mesmo produto
  console.log('=== 1. duas campanhas PAGAS e ATIVAS no mesmo produto, precos diferentes ===');
  const p1 = novoProduto('Prova Duas Promos', 100);
  novaPromo(p1, 80, "NOW() - interval '1 day'", "NOW() + interval '5 days'");
  novaPromo(p1, 60, "NOW() - interval '2 days'", "NOW() + interval '5 days'");
  console.log('   produto de R$ 100,00; campanha A por R$ 80,00; campanha B por R$ 60,00');

  q(SQL_ATIVAR);
  const precoAplicado = Number(q(`SELECT "promotionalPrice" FROM products WHERE id='${p1}'`));
  console.log(`   preco aplicado: R$ ${precoAplicado.toFixed(2)}`);

  // Roda de novo: a condicao IS DISTINCT FROM faz a query continuar
  // encontrando a OUTRA campanha e trocar o preco a cada rodada.
  q(SQL_ATIVAR);
  const depoisDaSegunda = Number(q(`SELECT "promotionalPrice" FROM products WHERE id='${p1}'`));
  q(SQL_ATIVAR);
  const depoisDaTerceira = Number(q(`SELECT "promotionalPrice" FROM products WHERE id='${p1}'`));
  console.log(`   apos 2a rodada do scheduler: R$ ${depoisDaSegunda.toFixed(2)}`);
  console.log(`   apos 3a rodada do scheduler: R$ ${depoisDaTerceira.toFixed(2)}`);

  const oscila = !(precoAplicado === depoisDaSegunda && depoisDaSegunda === depoisDaTerceira);
  check(
    !oscila,
    'o preco de venda e ESTAVEL entre rodadas do scheduler',
    oscila
      ? `OSCILA: ${precoAplicado} -> ${depoisDaSegunda} -> ${depoisDaTerceira}. O cliente paga um preco diferente conforme o minuto em que abrir a tela.`
      : `estavel em R$ ${precoAplicado.toFixed(2)}`,
  );

  // ═══════════════════════════ CENÁRIO 2: vencida + paga porém desligada
  console.log('\n=== 2. campanha VENCIDA, e outra PAGA mas DESLIGADA pelo lojista ===');
  const p2 = novoProduto('Prova Promo Desligada', 200);
  // A vencida ja aplicou o preco no produto.
  novaPromo(p2, 150, "NOW() - interval '10 days'", "NOW() - interval '1 day'");
  q(`UPDATE products SET "promotionalPrice" = 150 WHERE id='${p2}'`);
  // E existe uma paga, com janela futura, que o lojista DESLIGOU.
  novaPromo(p2, 170, "NOW() + interval '1 day'", "NOW() + interval '9 days'", { paga: true, ativa: false });
  console.log('   produto de R$ 200,00, com R$ 150,00 de uma campanha que VENCEU ontem');
  console.log('   e uma campanha paga de R$ 170,00 que o lojista DESLIGOU, para semana que vem');

  q(SQL_LIMPAR);
  const depoisDaLimpeza = q(`SELECT COALESCE("promotionalPrice"::text,'NULL') FROM products WHERE id='${p2}'`);
  console.log(`   depois da limpeza: ${depoisDaLimpeza === 'NULL' ? 'NULL (preco cheio)' : 'R$ ' + Number(depoisDaLimpeza).toFixed(2)}`);

  check(
    depoisDaLimpeza === 'NULL',
    'o preco de uma campanha VENCIDA e limpo',
    depoisDaLimpeza === 'NULL'
      ? 'voltou ao preco cheio'
      : `FICOU EM R$ ${Number(depoisDaLimpeza).toFixed(2)} para sempre. O guarda do NOT EXISTS confere isPaid mas nao isActive, entao a campanha DESLIGADA bloqueia a limpeza — e ela nunca vai ativar, porque o ativador exige isActive.`,
  );

  // ═══════════════════════════ CENÁRIO 3: o caso normal, que tem de funcionar
  console.log('\n=== 3. controle: uma campanha so, comportamento esperado ===');
  const p3 = novoProduto('Prova Promo Normal', 50);
  novaPromo(p3, 40, "NOW() - interval '1 hour'", "NOW() + interval '2 days'");
  q(SQL_ATIVAR);
  check(
    Number(q(`SELECT "promotionalPrice" FROM products WHERE id='${p3}'`)) === 40,
    'campanha unica e ativa aplica o preco dela',
  );

  const p4 = novoProduto('Prova Promo Vencida', 50);
  novaPromo(p4, 40, "NOW() - interval '9 days'", "NOW() - interval '2 days'");
  q(`UPDATE products SET "promotionalPrice" = 40 WHERE id='${p4}'`);
  q(SQL_LIMPAR);
  check(
    q(`SELECT COALESCE("promotionalPrice"::text,'NULL') FROM products WHERE id='${p4}'`) === 'NULL',
    'campanha vencida sem concorrente e limpa normalmente',
  );
} finally {
  if (criado) {
    try { adm(`DROP DATABASE IF EXISTS ${CLONE} WITH (FORCE)`); console.log(`\n(banco ${CLONE} apagado)`); }
    catch { console.log(`\n!! apague a mao: DROP DATABASE ${CLONE};`); }
  }
}

console.log(`\n=== ${ok.length} ok, ${achados.length} achado(s) ===`);
if (achados.length) {
  achados.forEach((a) => console.log('   >> ' + a));
  console.log('\nEstes definem POR QUANTO o produto e vendido, e portanto a base da');
  console.log('comissao e a fatia de cada um no split.');
  process.exit(1);
}
