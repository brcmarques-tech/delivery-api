import { DistanciaService } from './distancia.service';

/**
 * KAN-29. O que estes casos protegem, em ordem de dano:
 *
 *  1. o frete NUNCA pode derrubar um pedido por causa do roteador (chave
 *     ausente, timeout, 429, resposta estranha) — cai para linha reta e segue;
 *  2. a ordem das coordenadas: a ORS recebe [lng, lat]. Invertido ela NÃO dá
 *     erro — devolve a rota de outro lugar, com um número plausível. Seria um
 *     frete errado, silencioso e verossímil;
 *  3. o cache e o freio por minuto, que são o que mantém a cota gratuita
 *     (2.000/dia, 40/min) de pé num dia movimentado.
 */
const config = (valores: Record<string, string | undefined>) =>
  ({ get: (k: string) => valores[k] }) as any;

// Pelotas: centro -> Laranjal (~7 km em linha reta)
const LOJA = { lat: -31.7654, lng: -52.3376 };
const CLIENTE = { lat: -31.7354, lng: -52.2256 };

const respostaOrs = (metros: number, segundos: number) => ({
  ok: true,
  status: 200,
  json: async () => ({ routes: [{ summary: { distance: metros, duration: segundos } }] }),
  text: async () => '',
});

/**
 * fetch falso COERENTE com o pedido: calcula a linha reta das coordenadas que
 * foram enviadas e devolve `fator` vezes isso.
 *
 * Por que não um valor fixo: com 9 km fixos e um par de teste de 14 km em
 * linha reta, a resposta caía na guarda "rota menor que a linha reta é
 * impossível" e o serviço — corretamente — devolvia linha reta. Dois casos
 * falharam acusando o cache e o freio, e o errado era o meu dado.
 */
const fetchDeRota = (fator = 1.3, minutos = 15) =>
  jest.fn(async (_url: any, init: any) => {
    const corpo = JSON.parse(init.body);
    const [[lngA, latA], [lngB, latB]] = corpo.coordinates;
    const reta = DistanciaService.linhaRetaKm(latA, lngA, latB, lngB);
    return respostaOrs(reta * 1000 * fator, minutos * 60);
  });

describe('DistanciaService (KAN-29)', () => {
  const fetchOriginal = global.fetch;
  afterEach(() => {
    global.fetch = fetchOriginal;
    jest.restoreAllMocks();
  });

  it('sem chave da ORS: linha reta, sem chamar ninguém', async () => {
    const chamou = jest.fn();
    global.fetch = chamou as any;
    const svc = new DistanciaService(config({}));

    const d = await svc.entre(LOJA.lat, LOJA.lng, CLIENTE.lat, CLIENTE.lng);

    expect(d.fonte).toBe('linha-reta');
    expect(d.km).toBeGreaterThan(5);
    expect(d.km).toBeLessThan(15);
    expect(d.minutos).toBeGreaterThan(0);
    expect(chamou).not.toHaveBeenCalled();
  });

  it('com chave: usa a distância da ROTA, e a rota é maior que a linha reta', async () => {
    const reta = DistanciaService.linhaRetaKm(LOJA.lat, LOJA.lng, CLIENTE.lat, CLIENTE.lng);
    global.fetch = jest.fn(async () => respostaOrs(reta * 1000 * 1.35, 18 * 60)) as any;
    const svc = new DistanciaService(config({ ORS_API_KEY: 'chave-de-teste' }));

    const d = await svc.entre(LOJA.lat, LOJA.lng, CLIENTE.lat, CLIENTE.lng);

    expect(d.fonte).toBe('rota');
    expect(d.km).toBeCloseTo(reta * 1.35, 2);
    expect(d.minutos).toBe(18);
    // é este o ponto do ticket: o entregador não voa
    expect(d.km).toBeGreaterThan(reta);
  });

  it('manda [lng, lat] para a ORS, nessa ordem', async () => {
    const espiao = fetchDeRota();
    global.fetch = espiao as any;
    const svc = new DistanciaService(config({ ORS_API_KEY: 'k' }));

    await svc.entre(LOJA.lat, LOJA.lng, CLIENTE.lat, CLIENTE.lng);

    const corpo = JSON.parse((espiao.mock.calls[0][1] as any).body);
    expect(corpo.coordinates).toEqual([
      [LOJA.lng, LOJA.lat],
      [CLIENTE.lng, CLIENTE.lat],
    ]);
  });

  it('segunda consulta do mesmo par sai do cache (economia de cota)', async () => {
    const espiao = fetchDeRota();
    global.fetch = espiao as any;
    const svc = new DistanciaService(config({ ORS_API_KEY: 'k' }));

    const a = await svc.entre(LOJA.lat, LOJA.lng, CLIENTE.lat, CLIENTE.lng);
    const b = await svc.entre(LOJA.lat, LOJA.lng, CLIENTE.lat, CLIENTE.lng);

    expect(espiao).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('timeout da ORS: cai para linha reta em vez de travar o pedido', async () => {
    global.fetch = jest.fn((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        // simula o abort do AbortController
        init.signal.addEventListener('abort', () => {
          const e: any = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
    ) as any;
    const svc = new DistanciaService(config({ ORS_API_KEY: 'k', ORS_TIMEOUT_MS: '30' }));

    const d = await svc.entre(LOJA.lat, LOJA.lng, CLIENTE.lat, CLIENTE.lng);

    expect(d.fonte).toBe('linha-reta');
    expect(d.km).toBeGreaterThan(0);
  });

  it('HTTP 429 (cota do dia): linha reta, sem exceção', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded',
      json: async () => ({}),
    })) as any;
    const svc = new DistanciaService(config({ ORS_API_KEY: 'k' }));

    const d = await svc.entre(LOJA.lat, LOJA.lng, CLIENTE.lat, CLIENTE.lng);
    expect(d.fonte).toBe('linha-reta');
  });

  it('rota MENOR que a linha reta é impossível: desconfia e usa a linha reta', async () => {
    // Acontece de verdade quando as coordenadas vão trocadas ou o ponto é
    // encaixado na via errada. O número vem plausível, e é isso que o torna
    // perigoso.
    global.fetch = jest.fn(async () => respostaOrs(1000, 300)) as any;
    const svc = new DistanciaService(config({ ORS_API_KEY: 'k' }));

    const d = await svc.entre(LOJA.lat, LOJA.lng, CLIENTE.lat, CLIENTE.lng);

    expect(d.fonte).toBe('linha-reta');
    expect(d.km).toBeGreaterThan(5);
  });

  it('freio por minuto: estourado o teto, responde em linha reta', async () => {
    const espiao = fetchDeRota();
    global.fetch = espiao as any;
    const svc = new DistanciaService(config({ ORS_API_KEY: 'k', ORS_MAX_POR_MINUTO: '2' }));

    // pares diferentes, para não cair no cache
    const d1 = await svc.entre(LOJA.lat, LOJA.lng, -31.70, -52.20);
    const d2 = await svc.entre(LOJA.lat, LOJA.lng, -31.71, -52.21);
    const d3 = await svc.entre(LOJA.lat, LOJA.lng, -31.72, -52.22);

    expect(d1.fonte).toBe('rota');
    expect(d2.fonte).toBe('rota');
    expect(d3.fonte).toBe('linha-reta');
    expect(espiao).toHaveBeenCalledTimes(2);
  });

  it('coordenada inválida não vira NaN no frete', async () => {
    const svc = new DistanciaService(config({ ORS_API_KEY: 'k' }));
    const d = await svc.entre(LOJA.lat, LOJA.lng, NaN as any, CLIENTE.lng);
    expect(d.km).toBe(0);
    expect(Number.isFinite(d.km)).toBe(true);
  });
});
