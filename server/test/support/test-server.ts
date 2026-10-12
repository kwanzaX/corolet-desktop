import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module.js';
import { RagService } from '../../src/rag/rag.service.js';
import { fakeEngine } from './fakes.js';

/**
 * The real AppModule with RagService replaced by the in-memory store and a
 * scripted model, so REST, validation and Socket.IO run without Chroma or
 * Cloudflare. Used by the Vitest e2e suite and by the desktop Playwright tests.
 */
export async function startTestServer(opts: { port: number; responses: string[]; sleep?: number }) {
  const { engine } = fakeEngine(opts.responses, { sleep: opts.sleep });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RagService)
    .useValue({ engine })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.enableCors();
  await app.listen(opts.port, '127.0.0.1');
  return app;
}
