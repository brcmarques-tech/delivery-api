import Redis from 'ioredis';
import { OtpService } from './otp.service';
import { RedisOtpStore } from './otp-store';

/**
 * KAN-295 — DUAS INSTÂNCIAS DA API COMPARTILHAM O MESMO OTP?
 *
 * O bug que isto fecha não aparece em uma instância: com o store num `Map` do
 * processo, o código gerado na instância A não existe na B. O cliente recebe o
 * WhatsApp, digita o código certo e ouve "Codigo nao encontrado" — de forma
 * intermitente, conforme o balanceador escolhe. Junto vão o cooldown de 60s
 * (que não limita nada se cada instância tem o seu) e o limite de 5 tentativas
 * (que vira 5 POR INSTÂNCIA).
 *
 * Então o teste é literalmente esse cenário: DOIS OtpService, cada um com sua
 * conexão própria ao Redis, como dois processos. Nada aqui é mock.
 *
 * Sem Redis no ar os casos são PULADOS (e dizem por quê) — não falha o CI de
 * quem não tem o container de pé.
 */
const HOST = process.env.REDIS_HOST || 'localhost';
const PORT = Number(process.env.REDIS_PORT) || 6379;

const fazerInstancia = (whatsappOk = true) => {
  const whatsAppService = { sendText: jest.fn(async () => whatsappOk) } as any;
  const mailService = { sendVerificationCode: jest.fn(async () => undefined) } as any;
  // As MESMAS opções do runtime (criarOtpStore): fila offline ligada. Com ela
  // desligada, o primeiro comando saía antes da conexão subir e o teste
  // acusava o produto por "Stream isn't writeable" — erro do teste, não do
  // código, e foi assim que a opção errada no runtime apareceu.
  const redis = new Redis({ host: HOST, port: PORT, maxRetriesPerRequest: 2, connectTimeout: 5000 });
  const store = new RedisOtpStore(redis);
  const svc = new OtpService(whatsAppService, mailService, store);
  return { svc, whatsAppService, store, redis };
};

const codigoDoWhatsApp = (mock: any) =>
  String(mock.sendText.mock.calls[0][1]).match(/\*(\d{6})\*/)![1];

let redisVivo = false;

beforeAll(async () => {
  const sonda = new Redis({ host: HOST, port: PORT, maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
  try {
    await sonda.connect();
    await sonda.ping();
    redisVivo = true;
  } catch {
    redisVivo = false;
    // eslint-disable-next-line no-console
    console.warn(`[KAN-295] Redis em ${HOST}:${PORT} fora do ar — casos pulados.`);
  } finally {
    sonda.disconnect();
  }
});

describe('OTP compartilhado entre instâncias (KAN-295)', () => {
  const telefone = () => `5553${Math.floor(100000000 + Math.random() * 899999999)}`;

  it('código gerado na instância A verifica na instância B', async () => {
    if (!redisVivo) return;
    const A = fazerInstancia();
    const B = fazerInstancia();
    const fone = telefone();
    try {
      await A.svc.sendPhoneCode(fone);
      const codigo = codigoDoWhatsApp(A.whatsAppService);

      // Era AQUI que o cliente ficava preso: outra instância, "codigo nao
      // encontrado", com o código certo na mão.
      await expect(B.svc.verifyPhoneCode(fone, codigo)).resolves.toBe(true);
      // e a prova de verificação também vale na terceira instância que atender
      // o cadastro
      const C = fazerInstancia();
      await expect(C.svc.consumePhoneVerification(fone)).resolves.toBe(true);
      await C.store.encerrar();
    } finally {
      await A.store.encerrar();
      await B.store.encerrar();
    }
  });

  it('o cooldown de 60s vale entre instâncias', async () => {
    if (!redisVivo) return;
    const A = fazerInstancia();
    const B = fazerInstancia();
    const fone = telefone();
    try {
      await A.svc.sendPhoneCode(fone);
      // Sem store compartilhado, pedir de novo na outra instância reenviava na
      // hora — o "aguarde 60 segundos" era contornável só insistindo.
      await expect(B.svc.sendPhoneCode(fone)).rejects.toThrow(/60 segundos/);
    } finally {
      await A.store.encerrar();
      await B.store.encerrar();
    }
  });

  it('as 5 tentativas são somadas entre instâncias (não 5 em cada)', async () => {
    if (!redisVivo) return;
    const A = fazerInstancia();
    const B = fazerInstancia();
    const fone = telefone();
    try {
      await A.svc.sendPhoneCode(fone);
      const certo = codigoDoWhatsApp(A.whatsAppService);

      // 3 palpites numa, 2 na outra: total 5.
      for (let i = 0; i < 3; i++) {
        await expect(A.svc.verifyPhoneCode(fone, '000000')).rejects.toThrow(/incorreto/);
      }
      for (let i = 0; i < 2; i++) {
        await expect(B.svc.verifyPhoneCode(fone, '000000')).rejects.toThrow(/incorreto/);
      }
      // o 6o palpite, em qualquer instância, já é bloqueio
      await expect(B.svc.verifyPhoneCode(fone, '000000')).rejects.toThrow(/Muitas tentativas/);
      // e o código certo não vale mais (entrada envenenada, não apagada)
      await expect(A.svc.verifyPhoneCode(fone, certo)).rejects.toThrow();
      // com o cooldown ainda armado, para força bruta não se renovar
      await expect(A.svc.sendPhoneCode(fone)).rejects.toThrow(/60 segundos/);
    } finally {
      await A.store.encerrar();
      await B.store.encerrar();
    }
  });

  it('a prova de verificação é consumida UMA vez só, mesmo com duas instâncias tentando', async () => {
    if (!redisVivo) return;
    const A = fazerInstancia();
    const B = fazerInstancia();
    const fone = telefone();
    try {
      await A.svc.sendPhoneCode(fone);
      const codigo = codigoDoWhatsApp(A.whatsAppService);
      await A.svc.verifyPhoneCode(fone, codigo);

      // Duas requisições de cadastro simultâneas, em instâncias diferentes,
      // disputando a MESMA prova. Só uma pode ganhar — senão uma verificação
      // serve para dois cadastros.
      const [r1, r2] = await Promise.all([
        A.svc.consumePhoneVerification(fone),
        B.svc.consumePhoneVerification(fone),
      ]);
      expect([r1, r2].filter(Boolean)).toHaveLength(1);
    } finally {
      await A.store.encerrar();
      await B.store.encerrar();
    }
  });

  it('o código expira sozinho no Redis (TTL), sem varredura periódica', async () => {
    if (!redisVivo) return;
    const A = fazerInstancia();
    const fone = telefone();
    try {
      await A.svc.sendPhoneCode(fone);
      const ttl = await A.redis.pttl(`otp:phone:${fone}`);
      // 10 min de validade + 60s de folga; a folga existe para a mensagem de
      // erro ser "expirado" (clara) e não "nao encontrado".
      expect(ttl).toBeGreaterThan(9 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(11 * 60 * 1000 + 1000);
    } finally {
      await A.store.encerrar();
    }
  });
});
