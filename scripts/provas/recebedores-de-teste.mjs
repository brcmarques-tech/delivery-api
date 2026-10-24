// Os recebedores que os scripts de prova usam — REAIS, no sandbox do Pagar.me.
//
// POR QUE ISTO EXISTE
//
// Até 16/10/2026 cada script inventava um id ("re_test_cod_v", "re_cc_vendedor").
// O Pagar.me aceitava a criação da cobrança com HTTP 200 e devolvia a cobrança
// FALHADA dentro do corpo:
//
//   200 { charges:[{ status:'failed', last_transaction:{ status:'failed',
//         gateway_response:{ code:'404',
//         errors:[{ message:'Recipient not found' }] } } }] }
//
// Ninguém olhava o status da cobrança: o pedido ficava AWAITING_PAYMENT, o
// `simulatePayment` do superadmin aprovava por dentro, e o E2E seguia verde.
// Ou seja: a parte do caminho que fala com o gateway de verdade NUNCA foi
// exercitada — ela era simulada por acidente.
//
// A guarda `[PIX_NAO_GERADO]` (payments.service.ts) passou a recusar esse 200
// mentiroso, e aí os 6 E2E que usavam id fictício caíram de uma vez. O conserto
// certo não era afrouxar a guarda: era dar aos testes um recebedor que EXISTE.
//
// Os dois recebedores abaixo foram criados em 16/10/2026 via POST /recipients no
// sandbox (conta de testes), estão `active`, e vivem no .env. Nenhum código de
// aplicação os usa.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ_API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = fs.readFileSync(path.join(RAIZ_API, '.env'), 'utf8');
const ler = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();

function exigir(chave) {
  const v = ler(chave);
  if (!v) {
    throw new Error(
      `${chave} ausente no .env da API.\n` +
        'Sem um recebedor REAL do sandbox, a cobranca PIX nasce falhada no gateway ' +
        '("Recipient not found") e o teste nao exercita o caminho do dinheiro. ' +
        'Crie um com POST /recipients no sandbox e grave o id no .env.',
    );
  }
  return v;
}

export const RECEBEDOR_VENDEDOR = exigir('PAGARME_TEST_RECIPIENT_VENDOR_ID');
export const RECEBEDOR_ENTREGADOR = exigir('PAGARME_TEST_RECIPIENT_DELIVERER_ID');
export const RECEBEDOR_PLATAFORMA = exigir('PAGARME_PLATFORM_RECIPIENT_ID');
