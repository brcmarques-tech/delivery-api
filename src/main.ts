import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.enableCors({ origin: '*' });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`API rodando em http://localhost:${port}/graphql`);
}
bootstrap();
