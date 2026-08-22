import { readFileSync } from 'fs';

/**
 * KAN-232: TLS da conexao com o Postgres.
 *
 * ANTES: `ssl: { rejectUnauthorized: false }` fixo (app.module.ts e
 * data-source.ts). A conexao criptografava o trafego, mas aceitava QUALQUER
 * certificado — inclusive um forjado —, abrindo espaco para man-in-the-middle
 * entre a API e o banco (roubo de credenciais/dados em transito).
 *
 * AGORA: por padrao a API VALIDA o certificado do servidor. A criptografia
 * (a "feature") continua ligada; o que muda e passar a conferir com quem se
 * esta falando. Configuravel por env, do mais seguro ao menos:
 *
 *   DB_SSL_CA        CA (PEM, conteudo inline; use \n literais) do provedor.
 *   DB_SSL_CA_FILE   caminho para o arquivo PEM da CA.
 *                    -> valida o cert do servidor contra essa CA.
 *   DB_SSL_REJECT_UNAUTHORIZED=false
 *                    escape hatch EXPLICITO para bancos gerenciados com cert
 *                    self-signed que voce nao consegue fornecer a CA
 *                    (Heroku/Render/etc). Loga aviso a cada boot.
 *   DB_SSL=false     desliga o TLS por completo (so em rede confiavel).
 *
 * Retorna o objeto `ssl` do node-postgres (ou `false` para desligar).
 */
export function buildPostgresSsl(
  get: (key: string) => string | undefined,
): false | { rejectUnauthorized: boolean; ca?: string } {
  if (get('DB_SSL') === 'false') return false;

  const caInline = get('DB_SSL_CA');
  const caFile = get('DB_SSL_CA_FILE');
  let ca: string | undefined;
  if (caInline) {
    ca = caInline.replace(/\\n/g, '\n');
  } else if (caFile) {
    try {
      ca = readFileSync(caFile, 'utf8');
    } catch (e) {
      console.error(
        `[DB TLS] Nao consegui ler DB_SSL_CA_FILE (${caFile}): ${
          (e as Error).message
        }. Caindo na validacao padrao.`,
      );
    }
  }
  if (ca) return { ca, rejectUnauthorized: true };

  if (get('DB_SSL_REJECT_UNAUTHORIZED') === 'false') {
    console.warn(
      '[DB TLS] rejectUnauthorized=false — validacao do certificado do Postgres ' +
        'DESLIGADA (conexao vulneravel a man-in-the-middle). Prefira definir ' +
        'DB_SSL_CA/DB_SSL_CA_FILE com o certificado do provedor.',
    );
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}
