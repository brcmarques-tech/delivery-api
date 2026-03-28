import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { MailService } from './mail/mail.service';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1,
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalFilters(new Sentry.SentryGlobalFilter());
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true }));
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.enableCors({ origin: '*' });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`API rodando na porta ${port}`);

  // Auto-retry failed emails every hour (max 1 retry per email)
  const mailService = app.get(MailService);
  setInterval(() => {
    mailService.retryFailedEmails().catch(() => {});
  }, 60 * 60 * 1000);

  // Anti-sleep: ping a cada 10 min para manter todos os serviços do Render acordados
  const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  const vendorUrl = process.env.VENDOR_PANEL_URL;
  const superadminUrl = process.env.SUPERADMIN_URL;
  if (selfUrl) {
    const wahaUrl = process.env.WAHA_API_URL;
    const wahaKey = process.env.WAHA_API_KEY;
    setInterval(() => {
      fetch(`${selfUrl}/graphql?query={__typename}`).catch(() => {});
      if (vendorUrl) fetch(`${vendorUrl}/api/health`).catch(() => {});
      if (superadminUrl) fetch(`${superadminUrl}/api/health`).catch(() => {});
      if (wahaUrl) {
        // Keep WAHA session alive by checking session status (not just server version)
        fetch(`${wahaUrl}/api/sessions/default`, {
          headers: wahaKey ? { 'X-Api-Key': wahaKey } : {},
        }).catch(() => {});
      }
    }, 10 * 60 * 1000);
  }
}
bootstrap();
