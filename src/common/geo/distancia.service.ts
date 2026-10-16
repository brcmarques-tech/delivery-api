import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type FonteDaDistancia = 'rota' | 'linha-reta';

export interface Distancia {
  km: number;
  /** Duração estimada do trajeto de carro/moto, em minutos. */
  minutos: number;
  fonte: FonteDaDistancia;
}

/**
 * KAN-29 — DISTÂNCIA DE ENTREGA: ROTA DE VERDADE, NÃO LINHA RETA
 *
 * O frete era `base + km × preço/km` com km em LINHA RETA (haversine). O
 * entregador não voa: em Pelotas, com o canal e as avenidas de mão única, o
 * trajeto real passa fácil de 1,3× a linha reta. Quem pagava a diferença era
 * ele, em toda corrida, e justamente nas mais tortas.
 *
 * Agora a distância vem do OpenRouteService (rota de carro). A linha reta
 * continua existindo — como PLANO B, não como regra.
 *
 * DECISÕES QUE VALEM EXPLICAR
 *
 * 1. NUNCA derrubar um pedido por causa do roteador. Se a chave não estiver
 *    configurada, se a ORS demorar, se a cota do dia acabar ou se ela devolver
 *    erro, cai para a linha reta e SEGUE. Um pedido perdido custa mais caro
 *    que um frete um pouco subestimado — e o `fonte` conta qual dos dois
 *    valores foi usado, para não virar mistério no relatório.
 *
 * 2. CACHE de 24h por par de coordenadas arredondadas (4 casas ≈ 11 m). O
 *    plano gratuito da ORS dá 2.000 chamadas/dia, e o mesmo par loja→cliente
 *    se repete o dia inteiro (o app recalcula o frete a cada abertura da tela
 *    de checkout). Sem cache, um dia movimentado estoura a cota antes do
 *    almoço e todo mundo cai para a linha reta.
 *
 * 3. FREIO de chamadas por minuto. A ORS também limita por minuto (40 no plano
 *    gratuito); estourar devolve 429 e, pior, pode bloquear a chave. Quando o
 *    freio pega, a resposta é linha reta — de novo, sem derrubar nada.
 *
 * 4. O MESMO cálculo nos dois lugares. O app mostra o frete por
 *    `calculateDeliveryFee` e o servidor cobra o frete em `createOrder`: se um
 *    usasse rota e o outro linha reta, o cliente veria um preço e pagaria
 *    outro. Por isso a conta mora aqui, e os dois chamam este serviço.
 *
 * ATENÇÃO AO CALIBRAR O PREÇO: o frete MÉDIO sobe quando a distância passa a
 * ser a real. `deliveryPricePerKm` foi ajustado na época da linha reta —
 * revisar o número faz parte de ligar isto em produção.
 */
@Injectable()
export class DistanciaService {
  private readonly logger = new Logger(DistanciaService.name);

  /** Velocidade média urbana usada quando não há duração da rota. */
  private static readonly KMH_URBANO = 25;

  private readonly cache = new Map<string, { valor: Distancia; expiraEm: number }>();
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly TETO_CACHE = 5000;

  /** Janela do freio por minuto. */
  private chamadasNaJanela = 0;
  private janelaComecouEm = Date.now();

  constructor(private readonly config: ConfigService) {}

  private get chave(): string | undefined {
    return this.config.get<string>('ORS_API_KEY') || undefined;
  }
  private get url(): string {
    return (
      this.config.get<string>('ORS_URL') ||
      'https://api.openrouteservice.org/v2/directions/driving-car'
    );
  }
  private get tetoPorMinuto(): number {
    return Number(this.config.get<string>('ORS_MAX_POR_MINUTO')) || 30;
  }
  private get timeoutMs(): number {
    return Number(this.config.get<string>('ORS_TIMEOUT_MS')) || 2500;
  }

  /** Haversine — a única cópia desta conta no projeto. */
  static linhaRetaKm(latA: number, lngA: number, latB: number, lngB: number): number {
    const R = 6371;
    const rad = (g: number) => (g * Math.PI) / 180;
    const dLat = rad(latB - latA);
    const dLng = rad(lngB - lngA);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(latA)) * Math.cos(rad(latB)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private emLinhaReta(latA: number, lngA: number, latB: number, lngB: number): Distancia {
    const km = DistanciaService.linhaRetaKm(latA, lngA, latB, lngB);
    return {
      km,
      minutos: Math.max(1, Math.round((km / DistanciaService.KMH_URBANO) * 60)),
      fonte: 'linha-reta',
    };
  }

  private chaveDeCache(latA: number, lngA: number, latB: number, lngB: number): string {
    const r = (n: number) => n.toFixed(4);
    return `${r(latA)},${r(lngA)}>${r(latB)},${r(lngB)}`;
  }

  private podeChamar(): boolean {
    const agora = Date.now();
    if (agora - this.janelaComecouEm >= 60_000) {
      this.janelaComecouEm = agora;
      this.chamadasNaJanela = 0;
    }
    if (this.chamadasNaJanela >= this.tetoPorMinuto) return false;
    this.chamadasNaJanela++;
    return true;
  }

  /**
   * Distância e duração entre dois pontos. Nunca lança: na dúvida, devolve a
   * linha reta e diz que foi linha reta.
   */
  async entre(
    latOrigem: number,
    lngOrigem: number,
    latDestino: number,
    lngDestino: number,
  ): Promise<Distancia> {
    const coordenadasValidas = [latOrigem, lngOrigem, latDestino, lngDestino].every(
      (n) => Number.isFinite(n),
    );
    if (!coordenadasValidas) {
      return { km: 0, minutos: 0, fonte: 'linha-reta' };
    }

    const reta = this.emLinhaReta(latOrigem, lngOrigem, latDestino, lngDestino);
    if (!this.chave) return reta;

    const k = this.chaveDeCache(latOrigem, lngOrigem, latDestino, lngDestino);
    const emCache = this.cache.get(k);
    if (emCache && emCache.expiraEm > Date.now()) return emCache.valor;

    if (!this.podeChamar()) {
      this.logger.warn(
        `[ORS_FREIO] teto de ${this.tetoPorMinuto} chamadas/min atingido — usando linha reta`,
      );
      return reta;
    }

    const abortar = new AbortController();
    const relogio = setTimeout(() => abortar.abort(), this.timeoutMs);
    try {
      const resposta = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: this.chave,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        // A ORS recebe [lng, lat] — invertido em relação ao resto do mundo.
        // Trocar a ordem não dá erro: devolve uma rota de outro lugar, com um
        // número plausível. Por isso a conversão acontece só aqui.
        body: JSON.stringify({
          coordinates: [
            [lngOrigem, latOrigem],
            [lngDestino, latDestino],
          ],
        }),
        signal: abortar.signal,
      });

      if (!resposta.ok) {
        const corpo = await resposta.text().catch(() => '');
        this.logger.warn(
          `[ORS_FALHOU] HTTP ${resposta.status} — usando linha reta. ${corpo.slice(0, 160)}`,
        );
        return reta;
      }

      const dados: any = await resposta.json();
      const resumo =
        dados?.routes?.[0]?.summary ?? dados?.features?.[0]?.properties?.summary;
      const metros = Number(resumo?.distance);
      const segundos = Number(resumo?.duration);

      if (!Number.isFinite(metros) || metros <= 0) {
        this.logger.warn('[ORS_FALHOU] resposta sem distância — usando linha reta');
        return reta;
      }

      const rota: Distancia = {
        km: metros / 1000,
        minutos: Number.isFinite(segundos) && segundos > 0
          ? Math.max(1, Math.round(segundos / 60))
          : reta.minutos,
        fonte: 'rota',
      };

      // Sanidade: rota menor que a linha reta é geometricamente impossível —
      // significa que a resposta não é do trajeto que pedimos (coordenadas
      // trocadas, ponto encaixado na via errada). Nesse caso a linha reta é o
      // número mais honesto.
      if (rota.km < reta.km * 0.95) {
        this.logger.warn(
          `[ORS_SUSPEITO] rota ${rota.km.toFixed(2)}km < linha reta ${reta.km.toFixed(2)}km — usando linha reta`,
        );
        return reta;
      }

      if (this.cache.size >= DistanciaService.TETO_CACHE) {
        // Sem LRU: joga fora a chave mais antiga inserida. O cache aqui é
        // economia de cota, não correção — simplicidade vale mais.
        const primeira = this.cache.keys().next().value;
        if (primeira) this.cache.delete(primeira);
      }
      this.cache.set(k, { valor: rota, expiraEm: Date.now() + DistanciaService.TTL_MS });
      return rota;
    } catch (err: any) {
      const motivo = err?.name === 'AbortError' ? `timeout ${this.timeoutMs}ms` : err?.message;
      this.logger.warn(`[ORS_FALHOU] ${motivo} — usando linha reta`);
      return reta;
    } finally {
      clearTimeout(relogio);
    }
  }
}
