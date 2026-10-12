import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? '*').split(',') });
  app.useBodyParser('json', { limit: '2mb' });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3070);
  await app.listen(port, process.env.HOST ?? '127.0.0.1');
}

bootstrap();
