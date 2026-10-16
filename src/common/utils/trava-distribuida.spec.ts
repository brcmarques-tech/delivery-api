import { DataSource } from 'typeorm';
import { comTravaDistribuida } from './trava-distribuida';

/**
 * KAN-254. A trava é uma dessas peças em que "parece certo" não basta: se ela
 * não travar, nada quebra visivelmente — só sai notificação em dobro e dois
 * processos disputam as mesmas linhas, em produção, no dia em que a infra
 * escalar. E se ela travar demais (não soltar), o scheduler para de rodar e
 * também ninguém percebe na hora.
 *
 * Então os casos são: trava de verdade, SOLTA de verdade, e nunca derruba o
 * tick quando o banco falha.
 *
 * Roda contra o Postgres LOCAL (o mesmo do docker-compose). Sem banco, os
 * casos que precisam dele são pulados — e dizem por quê.
 */
const conexao = {
  type: 'postgres' as const,
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME || 'shopping',
  password: process.env.DB_PASSWORD || 'shopping',
  database: process.env.DB_DATABASE || 'shopping_db',
  // Sem entidades: isto não é teste de ORM, é de concorrência no banco.
  entities: [],
  synchronize: false,
};

describe('comTravaDistribuida (KAN-254)', () => {
  let a: DataSource | null = null;
  let b: DataSource | null = null;
  let vivo = false;

  beforeAll(async () => {
    try {
      // Duas DataSources = duas "instâncias da API". É o cenário do ticket.
      a = await new DataSource(conexao).initialize();
      b = await new DataSource(conexao).initialize();
      vivo = true;
    } catch {
      vivo = false;
      // eslint-disable-next-line no-console
      console.warn('[KAN-254] Postgres local fora do ar — casos da trava pulados.');
    }
  });

  afterAll(async () => {
    await a?.destroy().catch(() => {});
    await b?.destroy().catch(() => {});
  });

  it('duas instâncias, um tick só', async () => {
    if (!vivo) return;
    const nome = `teste:trava:${Date.now()}`;
    let rodou = 0;
    let soltaA: () => void = () => {};
    const seguraA = new Promise<void>((r) => { soltaA = r; });

    // A pega a trava e fica dentro dela
    const execucaoA = comTravaDistribuida(a!, nome, async () => {
      rodou++;
      await seguraA;
      return 'A';
    });
    // dá tempo de A pegar a trava antes de B tentar
    await new Promise((r) => setTimeout(r, 150));

    const resultadoB = await comTravaDistribuida(b!, nome, async () => {
      rodou++;
      return 'B';
    });

    // B não rodou: é exatamente o que a trava existe para fazer.
    expect(resultadoB).toBeNull();
    expect(rodou).toBe(1);

    soltaA();
    await expect(execucaoA).resolves.toBe('A');
  });

  it('solta a trava no fim — senão o scheduler nunca mais roda', async () => {
    if (!vivo) return;
    const nome = `teste:solta:${Date.now()}`;
    await comTravaDistribuida(a!, nome, async () => 'primeiro');
    // Mesma instância e a outra conseguem depois: a trava foi liberada.
    await expect(comTravaDistribuida(a!, nome, async () => 'segundo')).resolves.toBe('segundo');
    await expect(comTravaDistribuida(b!, nome, async () => 'terceiro')).resolves.toBe('terceiro');
  });

  it('solta a trava mesmo quando a tarefa EXPLODE', async () => {
    if (!vivo) return;
    const nome = `teste:erro:${Date.now()}`;
    await expect(
      comTravaDistribuida(a!, nome, async () => {
        throw new Error('falha no meio do tick');
      }),
    ).resolves.toBeNull(); // o erro é registrado, não propagado: o scheduler segue vivo
    // e a trava não ficou presa
    await expect(comTravaDistribuida(b!, nome, async () => 'depois')).resolves.toBe('depois');
  });

  it('banco fora do ar não derruba o tick', async () => {
    const morto = {
      createQueryRunner: () => ({
        connect: async () => { throw new Error('sem conexao'); },
        query: async () => { throw new Error('sem conexao'); },
        release: async () => {},
      }),
    } as unknown as DataSource;

    await expect(comTravaDistribuida(morto, 'teste:morto', async () => 'nunca')).resolves.toBeNull();
  });
});
