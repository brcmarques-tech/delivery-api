import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * KAN-295 — ONDE O CÓDIGO OTP MORA
 *
 * O problema: o store era um `Map` dentro do processo. Com DUAS instâncias da
 * API atrás de um balanceador, o código gerado na instância A não existe na B:
 * o cliente recebe o SMS/WhatsApp, digita o código certo e ouve "Codigo nao
 * encontrado. Solicite um novo." — em metade das tentativas, sem padrão
 * aparente. O mesmo vale para o cooldown de 60s (que não limita nada se o
 * atacante cai em instâncias diferentes), para o limite de 5 tentativas (que
 * passa a ser 5 POR INSTÂNCIA) e para a prova de verificação do KAN-231, que o
 * cadastro consome: verificar numa instância e cadastrar na outra falharia.
 *
 * Em uma instância nada disso aparece. É exatamente o tipo de defeito que
 * estreia no dia em que a infra escala.
 *
 * DUAS IMPLEMENTAÇÕES, MESMO CONTRATO:
 *
 *   RedisOtpStore   — a de verdade. O TTL do Redis cuida da expiração (não há
 *                     varredura periódica), o incremento de tentativa é atômico
 *                     (HINCRBY) e o consumo da prova é atômico (GETDEL), então
 *                     duas requisições simultâneas não gastam a mesma prova
 *                     duas vezes.
 *
 *   MemoriaOtpStore — o comportamento anterior, para dev sem Redis e para os
 *                     testes unitários. Fica explícito que é single-instance.
 *
 * O QUE **NÃO** PODE SE PERDER NA MUDANÇA (tudo isto é conquista de bug
 * anterior, documentada em otp.service.ts):
 *   - o cooldown de reenvio é derivado da EXISTÊNCIA da entrada;
 *   - estourar as tentativas NÃO apaga a entrada: envenena o código e re-arma
 *     o cooldown uma única vez;
 *   - a prova de verificação é de uso único.
 * Por isso o contrato abaixo tem `envenenar` e `consumirVerificado` como
 * operações próprias, em vez de um `set` genérico: o que é atômico no Redis
 * precisa ser nomeado para continuar atômico.
 */
/** Token de injecao do store (o Nest nao injeta interface). */
export const OTP_STORE = Symbol('OTP_STORE');

export interface EntradaOtp {
  code: string;
  expiresAt: number;
  attempts: number;
}

export interface OtpStore {
  /** Nome da implementação, para o log de boot dizer onde o OTP está. */
  readonly tipo: 'redis' | 'memoria';
  pegar(chave: string): Promise<EntradaOtp | null>;
  gravar(chave: string, entrada: EntradaOtp): Promise<void>;
  apagar(chave: string): Promise<void>;
  /** Incrementa e devolve o total de tentativas (atômico). */
  contarTentativa(chave: string): Promise<number>;
  /** Zera o código e estende a validade (cooldown re-armado). */
  envenenar(chave: string, expiraEm: number): Promise<void>;
  marcarVerificado(chave: string, expiraEm: number): Promise<void>;
  /** Consome a prova de verificação (uso único, atômico). */
  consumirVerificado(chave: string): Promise<boolean>;
  encerrar(): Promise<void>;
}

const PREFIXO = 'otp:';
const PREFIXO_OK = 'otp-ok:';

export class RedisOtpStore implements OtpStore {
  readonly tipo = 'redis' as const;
  private readonly logger = new Logger(RedisOtpStore.name);

  constructor(private readonly redis: Redis) {}

  private k(chave: string) { return PREFIXO + chave; }
  private kOk(chave: string) { return PREFIXO_OK + chave; }

  async pegar(chave: string): Promise<EntradaOtp | null> {
    const h = await this.redis.hgetall(this.k(chave));
    if (!h || !h.expiresAt) return null;
    return {
      // Hash do Redis guarda string: código vazio (envenenado) tem que
      // continuar sendo string vazia, e não `undefined`.
      code: h.code ?? '',
      expiresAt: Number(h.expiresAt),
      attempts: Number(h.attempts || 0),
    };
  }

  async gravar(chave: string, entrada: EntradaOtp): Promise<void> {
    const k = this.k(chave);
    await this.redis
      .multi()
      .del(k)
      .hset(k, {
        code: entrada.code,
        expiresAt: String(entrada.expiresAt),
        attempts: String(entrada.attempts),
      })
      // +60s de folga: a expiração de VERDADE é conferida por `expiresAt` no
      // serviço. O TTL só impede lixo eterno — se ele cortasse exatamente no
      // instante do vencimento, o erro mudaria de "Codigo expirado" (claro)
      // para "Codigo nao encontrado" (que manda o usuário pedir outro sem
      // entender por quê), e o cooldown de reenvio sumiria junto.
      .pexpire(k, Math.max(1000, entrada.expiresAt - Date.now() + 60_000))
      .exec();
  }

  async apagar(chave: string): Promise<void> {
    await this.redis.del(this.k(chave));
  }

  async contarTentativa(chave: string): Promise<number> {
    return this.redis.hincrby(this.k(chave), 'attempts', 1);
  }

  async envenenar(chave: string, expiraEm: number): Promise<void> {
    const k = this.k(chave);
    await this.redis
      .multi()
      .hset(k, { code: '', expiresAt: String(expiraEm) })
      .pexpire(k, Math.max(1000, expiraEm - Date.now() + 60_000))
      .exec();
  }

  async marcarVerificado(chave: string, expiraEm: number): Promise<void> {
    await this.redis.set(
      this.kOk(chave),
      String(expiraEm),
      'PX',
      Math.max(1000, expiraEm - Date.now()),
    );
  }

  async consumirVerificado(chave: string): Promise<boolean> {
    const k = this.kOk(chave);
    // GETDEL é atômico: duas chamadas simultâneas não consomem a mesma prova.
    // Em Redis < 6.2 não existe, e aí o fallback é GET + DEL — menos garantido,
    // mas melhor que falhar o cadastro de quem verificou.
    let valor: string | null;
    try {
      valor = await (this.redis as any).getdel(k);
    } catch {
      valor = await this.redis.get(k);
      if (valor) await this.redis.del(k);
    }
    if (!valor) return false;
    return Number(valor) >= Date.now();
  }

  async encerrar(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

export class MemoriaOtpStore implements OtpStore {
  readonly tipo = 'memoria' as const;
  private readonly store = new Map<string, EntradaOtp>();
  private readonly verificados = new Map<string, number>();
  private faxina?: ReturnType<typeof setInterval>;

  constructor() {
    // Sem TTL do Redis, alguém tem que varrer. `unref` para o processo (e o
    // jest) poderem encerrar com o timer pendurado.
    this.faxina = setInterval(() => {
      const agora = Date.now();
      for (const [k, e] of this.store) if (e.expiresAt < agora) this.store.delete(k);
      for (const [k, exp] of this.verificados) if (exp < agora) this.verificados.delete(k);
    }, 5 * 60 * 1000);
    this.faxina.unref?.();
  }

  async pegar(chave: string) {
    const e = this.store.get(chave);
    return e ? { ...e } : null;
  }
  async gravar(chave: string, entrada: EntradaOtp) {
    this.store.set(chave, { ...entrada });
  }
  async apagar(chave: string) {
    this.store.delete(chave);
  }
  async contarTentativa(chave: string) {
    const e = this.store.get(chave);
    if (!e) return 0;
    e.attempts++;
    return e.attempts;
  }
  async envenenar(chave: string, expiraEm: number) {
    const e = this.store.get(chave);
    if (!e) return;
    e.code = '';
    e.expiresAt = expiraEm;
  }
  async marcarVerificado(chave: string, expiraEm: number) {
    this.verificados.set(chave, expiraEm);
  }
  async consumirVerificado(chave: string) {
    const exp = this.verificados.get(chave);
    if (!exp) return false;
    this.verificados.delete(chave);
    return exp >= Date.now();
  }
  async encerrar() {
    if (this.faxina) clearInterval(this.faxina);
  }
}

/**
 * Escolhe a implementação. Com REDIS_HOST configurado, usa Redis; sem ele, cai
 * para memória com um AVISO — porque rodar duas instâncias com store em
 * memória é um defeito silencioso, e silêncio é o que o KAN-295 queria tirar.
 */
export function criarOtpStore(ler: (chave: string) => string | undefined): OtpStore {
  const logger = new Logger('OtpStore');
  const host = ler('REDIS_HOST');
  if (!host) {
    logger.warn(
      'REDIS_HOST nao configurado: OTP em MEMORIA. Funciona com UMA instancia da API; ' +
        'com duas, o codigo gerado numa nao existe na outra (KAN-295).',
    );
    return new MemoriaOtpStore();
  }
  const redis = new Redis({
    host,
    port: Number(ler('REDIS_PORT')) || 6379,
    password: ler('REDIS_PASSWORD') || undefined,
    // O OTP não é cache: se o Redis cair de vez, melhor a chamada falhar
    // rápido e o usuário pedir outro código do que a requisição ficar
    // pendurada. Por isso o teto de retentativas.
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    // A FILA OFFLINE FICA LIGADA (padrão), e isto não é descuido. Medido ao
    // escrever o teste: com ela desligada, qualquer comando emitido antes da
    // conexão terminar de subir morre na hora com "Stream isn't writeable" —
    // ou seja, o PRIMEIRO pedido de código depois de cada deploy, e qualquer
    // um durante uma reconexão de meio segundo, falharia para o usuário. Com a
    // fila, uma piscada de rede é esperada; uma queda de verdade ainda falha,
    // porque o maxRetriesPerRequest limita a espera.
    lazyConnect: false,
  });
  redis.on('error', (e) => logger.error(`Redis do OTP: ${e.message}`));
  logger.log(`OTP no Redis em ${host}:${Number(ler('REDIS_PORT')) || 6379}`);
  return new RedisOtpStore(redis);
}
