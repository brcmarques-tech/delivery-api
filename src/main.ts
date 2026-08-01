import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { MailService } from './mail/mail.service';
import { fetchWithTimeout } from './common/utils/fetch-with-timeout'; // KAN-253

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1,
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true }));
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // KAN-228: CORS era `origin: '*'` fixo — a API aceitava requisicao de
  // qualquer site. Agora vem de CORS_ORIGINS (lista separada por virgula).
  // Fora de producao, mantem '*' para nao atrapalhar o desenvolvimento.
  // Em producao sem a variavel definida, tambem cai em '*' e loga um aviso
  // ALTO, em vez de derrubar o trafego dos apps por config faltando.
  const corsEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const isProd = process.env.NODE_ENV === 'production';

  if (corsEnv.length > 0) {
    app.enableCors({ origin: corsEnv, credentials: true });
    console.log(`CORS restrito a: ${corsEnv.join(', ')}`);
  } else {
    if (isProd) {
      console.warn(
        '[SEGURANCA] CORS_ORIGINS nao definido em producao — liberando origin:* . ' +
          'Defina a allowlist (ex.: https://shopping.bcmtech.com.br,https://adminshopping.bcmtech.com.br,https://shop.bcmtech.com.br).',
      );
    }
    app.enableCors({ origin: '*' });
  }

  const port = process.env.PORT || 3000;
  // Sem isto o Nest nao dispara onModuleDestroy no SIGTERM — os clearInterval
  // dos 4 schedulers (e do OTP) nunca rodam no shutdown.
  app.enableShutdownHooks();

  await app.listen(port);
  console.log(`API rodando na porta ${port}`);

  // Auto-retry failed emails every hour (max 1 retry per email)
  const mailService = app.get(MailService);
  setInterval(() => {
    mailService.retryFailedEmails().catch(() => {});
  }, 60 * 60 * 1000);

  // KAN-253: este bloco era o "anti-sleep" da epoca do Render — pings a cada 10
  // min no proprio servico e nos dois paineis para o free tier nao hibernar. A
  // infra hoje e Lightsail, que nao hiberna, entao aqueles pings so geravam
  // trafego e ruido (e a referencia a RENDER_EXTERNAL_URL confundia quem lia).
  //
  // Mantido APENAS o keep-alive da sessao do WAHA, que tem proposito real: a
  // sessao do WhatsApp cai sozinha se ficar ociosa.
  const wahaUrl = process.env.WAHA_API_URL;
  const wahaKey = process.env.WAHA_API_KEY;
  if (wahaUrl) {
    setInterval(() => {
      fetchWithTimeout(`${wahaUrl}/api/sessions/default`, {
        headers: wahaKey ? { 'X-Api-Key': wahaKey } : {},
      }).catch(() => {});
    }, 10 * 60 * 1000);
  }
}
// BUGFIX: `bootstrap()` era chamado sem `.catch()`. Uma falha no boot (banco
// momentaneamente indisponivel, coluna faltando, seed/site-config falhando)
// virava unhandled rejection: o Node derruba o processo com stack trace cru,
// SEM evento no Sentry (o filtro global so cobre escopo de request) — ninguem
// fica sabendo por que a API nao subiu.
bootstrap().catch((err) => {
  try {
    Sentry.captureException(err);
  } catch {}
  console.error('[BOOTSTRAP] Falha ao iniciar a API:', err);
  process.exit(1);
});
