import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { MailService } from './mail/mail.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  // Anti-sleep: ping a cada 14 min para manter todos os serviços do Render acordados
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  const vendorUrl = process.env.VENDOR_PANEL_URL;
  const superadminUrl = process.env.SUPERADMIN_URL;
  if (selfUrl) {
    setInterval(() => {
      fetch(`${selfUrl}/graphql?query={__typename}`).catch(() => {});
      if (vendorUrl) fetch(`${vendorUrl}/api/health`).catch(() => {});
      if (superadminUrl) fetch(`${superadminUrl}/api/health`).catch(() => {});
    }, 14 * 60 * 1000);
  }
}
bootstrap();
