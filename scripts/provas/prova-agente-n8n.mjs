// ═══════════════════════════════════════════════════════════════════════════
// KAN-199 — O AGENTE DO WHATSAPP RECONHECE O LOJISTA E AGE NA LOJA
// ═══════════════════════════════════════════════════════════════════════════
//
// O defeito que isto fecha: o roteador só procurava a loja por
// `stores.whatsappNumber` — um campo que o lojista preenche no painel e que a
// maioria deixa em branco. Quando ele mandava mensagem do PRÓPRIO celular, o
// roteador não achava loja, concluía "não é vendedor" e jogava a conversa no
// agente do CLIENTE: prompt errado, ferramentas erradas, e o lojista sem
// entender por que o assistente não sabe nada do negócio dele.
//
// A prova cobre o endpoint novo (é ele que o roteador chama) e a fiação dos
// workflows — que são JSON versionado no repositório e, portanto, podem
// divergir em silêncio do que o backend oferece.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = 'http://localhost:3000';
const RAIZ = 'D:/linux/Documents/bcmTech/shopping-api';
const ok = [], fail = [];
const check = (c, n, d = '') => { (c ? ok : fail).push(n); console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
const titulo = (t) => console.log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);

function sql(q) {
  return execSync(
    `docker exec shopping-postgres psql -U shopping -d shopping_db -tAc "${q.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' },
  ).trim();
}
const env = readFileSync(`${RAIZ}/.env`, 'utf8');
const CHAVE = (env.match(/^N8N_AGENT_KEY=(.*)$/m) || [])[1]?.trim();

async function agente(caminho, { metodo = 'GET', chave = CHAVE } = {}) {
  const r = await fetch(`${API}/n8n${caminho}`, {
    method: metodo,
    headers: chave ? { 'X-N8N-Key': chave } : {},
  });
  const texto = await r.text();
  let corpo = null;
  try { corpo = JSON.parse(texto); } catch {}
  return { status: r.status, corpo, texto };
}

const ts = Date.now();
const suf = String(ts).slice(-6);

titulo('1. CENÁRIO: lojista com telefone próprio, loja SEM WhatsApp cadastrado');
check(!!CHAVE, 'li a N8N_AGENT_KEY do .env (sem ela nada aqui funciona)');

const telefone = `5553${String(ts).slice(-9)}`;
const email = `n8n_v_${ts}@t.com`;
const registro = await fetch(`${API}/graphql`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: `mutation{ registerVendor(input:{name:"Lojista N8N",email:"${email}",password:"teste123",phone:"${telefone}",cpf:"${cpfValido()}"}){ accessToken } }`,
  }),
}).then((r) => r.json());
check(!registro.errors, 'lojista cadastrado', registro.errors?.[0]?.message);

const vid = sql(`SELECT id FROM vendor_users WHERE email='${email}'`);
sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "acceptedSubscriptionTermsAt"=now() WHERE id='${vid}'`);
const storeId = sql(
  `INSERT INTO stores (name, phone, street, number, neighborhood, city, state, "zipCode", latitude, longitude, "ownerId") ` +
  `VALUES ('Loja N8N ${suf}','5391000','R','1','Centro','Pelotas','RS','96000000',-31.77,-52.34,'${vid}') RETURNING id`,
).split('\n')[0].trim();
check(!!storeId, 'loja criada SEM whatsappNumber (o caso real: o campo fica em branco)');

titulo('2. O CAMINHO ANTIGO FALHA — e é por isso que o novo existe');
const porLoja = await agente(`/stores/by-phone?phone=${telefone}`);
check(porLoja.corpo === null || porLoja.texto === '',
  'busca pelo WhatsApp DA LOJA não acha nada (loja sem o campo preenchido)',
  porLoja.texto.slice(0, 40));

titulo('3. O CAMINHO NOVO ACHA O LOJISTA');
const porLojista = await agente(`/vendors/by-phone?phone=${telefone}`);
check(porLojista.status === 200 && !!porLojista.corpo?.id,
  'busca pelo telefone do LOJISTA devolve a loja',
  `${porLojista.corpo?.name} (${porLojista.corpo?.vendorName})`);
check(porLojista.corpo?.name?.includes('Loja N8N'),
  'com o NOME da loja — que é o que o agente usa para se apresentar',
  porLojista.corpo?.name);
check(Array.isArray(porLojista.corpo?.stores) && porLojista.corpo.stores.length === 1,
  'e a lista de lojas do lojista');

titulo('4. DUAS LOJAS: não adivinha');
const segunda = sql(
  `INSERT INTO stores (name, phone, street, number, neighborhood, city, state, "zipCode", latitude, longitude, "ownerId") ` +
  `VALUES ('Loja N8N B ${suf}','5391000','R','2','Centro','Pelotas','RS','96000000',-31.77,-52.34,'${vid}') RETURNING id`,
).split('\n')[0].trim();
const comDuas = await agente(`/vendors/by-phone?phone=${telefone}`);
check(comDuas.corpo?.id === null,
  'com duas lojas, NÃO escolhe uma — mandar o pedido para a loja errada é pior que perguntar',
  JSON.stringify(comDuas.corpo?.id));
check(comDuas.corpo?.stores?.length === 2, 'mas devolve as duas para o roteador perguntar');
sql(`DELETE FROM stores WHERE id='${segunda}'`);

titulo('5. A CHAVE PROTEGE O ENDPOINT');
const semChave = await agente(`/vendors/by-phone?phone=${telefone}`, { chave: '' });
check(semChave.status === 401, 'sem a chave: 401', String(semChave.status));
const chaveErrada = await agente(`/vendors/by-phone?phone=${telefone}`, { chave: 'x'.repeat(40) });
check(chaveErrada.status === 401, 'com chave errada: 401', String(chaveErrada.status));

titulo('6. OS WORKFLOWS DO n8n ESTÃO LIGADOS NO QUE O BACKEND OFERECE');
const roteador = JSON.parse(readFileSync(`${RAIZ}/n8n-workflows/waha_router.json`, 'utf8'));
const agenteVendedor = JSON.parse(readFileSync(`${RAIZ}/n8n-workflows/vendor_agent.json`, 'utf8'));

const noVendor = roteador.nodes.find((n) => n.name === 'Find Vendor by Phone');
check(!!noVendor, 'o roteador tem o nó que procura o LOJISTA');
check(/vendors\/by-phone/.test(JSON.stringify(noVendor?.parameters || {})),
  'e ele chama o endpoint novo');
check(
  JSON.stringify(roteador.connections['Is Vendor?']).includes('Find Vendor by Phone'),
  'ligado no ramo FALSO da busca por loja (só tenta quando a primeira falha)',
);
check(
  JSON.stringify(roteador.connections['Is Vendor (owner)?']).includes('Prep Vendor Input') &&
    JSON.stringify(roteador.connections['Is Vendor (owner)?']).includes('Find User by Phone'),
  'e quem não é lojista segue para o caminho de cliente, como antes',
);

const ferramenta = agenteVendedor.nodes.find((n) => n.name === 'Toggle Product Availability');
check(!!ferramenta, 'o agente ganhou a ferramenta de disponibilidade de produto');
check(/products\/.*availability/.test(JSON.stringify(ferramenta?.parameters || {})),
  'apontando para o endpoint que já existia no backend e ninguém usava');
check(
  JSON.stringify(ferramenta?.parameters || {}).includes("$('Execute Workflow Trigger').first().json.storeId"),
  'com o storeId DA CONVERSA — o agente não pode esconder produto de outra loja',
);
const prompt = agenteVendedor.nodes.find((n) => n.name === 'Vendor AI Agent')?.parameters?.systemMessage || '';
check(/indispon[ií]vel/i.test(prompt),
  'e o prompt sabe que a ferramenta existe (senão ela nunca é usada)');
check(/storeName/.test(prompt), 'o agente continua se apresentando com o nome da loja');

// Toda ferramenta do agente tem que apontar para uma rota que o controller
// expõe — JSON no repositório diverge do backend em silêncio.
const controller = readFileSync(`${RAIZ}/src/n8n-agent/n8n-agent.controller.ts`, 'utf8');
const rotas = [...controller.matchAll(/@(Get|Post|Patch)\('([^']+)'\)/g)].map((m) => m[2]);
const ferramentas = agenteVendedor.nodes.filter((n) => /toolHttpRequest/.test(n.type));
let todasExistem = true;
const estaticos = (caminho) =>
  // Só os pedaços LITERAIS do caminho, na ordem. A URL de uma ferramenta do
  // n8n pode ser uma expressão inteira ("stores/\" + id + \"/toggle-open"),
  // então comparar texto cru acusa rota inexistente onde ela existe — foi o
  // que esta checagem fez na primeira versão, com o toggle-open.
  (caminho.match(/[a-z][a-z0-9-]*/gi) || []).filter((seg) => !/^(json|item|first|env|n8n|http|https)$/i.test(seg));

for (const f of ferramentas) {
  const url = String(f.parameters?.url || '');
  const depoisDoN8n = url.split('/n8n/')[1] || '';
  // tira as expressões {{ ... }} e o que sobra de concatenação
  const literal = depoisDoN8n.replace(/\{\{[\s\S]*?\}\}/g, ' ').replace(/['"+]/g, ' ');
  const segs = estaticos(literal);
  const casa = rotas.some((r) => {
    const segsRota = estaticos(r.replace(/:[^/]+/g, ' '));
    return segsRota.length > 0 && segsRota.every((seg) => segs.includes(seg));
  });
  if (!casa) {
    todasExistem = false;
    console.log(`   ! ferramenta "${f.name}" aponta para ${depoisDoN8n.slice(0, 60)}, que não casa com nenhuma rota do controller`);
  }
}
check(todasExistem, `as ${ferramentas.length} ferramentas do agente apontam para rotas que existem`);

titulo(`RESULTADO: ${ok.length} ok, ${fail.length} falha(s)`);
if (fail.length) {
  for (const f of fail) console.log(`   ❌ ${f}`);
  process.exit(1);
}
console.log('   o lojista fala do celular dele e o agente sabe de que loja se trata.');

function cpfValido() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const d = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * (a.length + 1 - i); const r = 11 - (s % 11); return r >= 10 ? 0 : r; };
  const d1 = d(n), d2 = d([...n, d1]);
  return [...n, d1, d2].join('');
}
