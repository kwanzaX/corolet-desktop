import { afterEach, expect, test, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { RagService } from '../src/rag/rag.service.js';
import { ChatCloudflare, CloudflareEmbeddings } from '../src/ai/cloudflare.js';

const CREDS = { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AI_TOKEN: 'tok' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Building the service only configures clients; nothing connects until the first query. */
async function init(env: Record<string, string>) {
  for (const [k, v] of Object.entries({ ...CREDS, ...env })) vi.stubEnv(k, v);
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  const svc = new RagService();
  await svc.onModuleInit();
  const e = svc.engine as any;
  return { e, store: e.store, log };
}

test('defaults: local Chroma in cosine space, k = 4, threshold 0.5, Cloudflare models', async () => {
  vi.stubEnv('CHROMA_URL', undefined as any);
  vi.stubEnv('CHROMA_COLLECTION', undefined as any);
  vi.stubEnv('RAG_K', undefined as any);
  vi.stubEnv('RAG_MIN_RELEVANCE', undefined as any);
  const { e, store, log } = await init({});
  expect(store.url).toBe('http://127.0.0.1:8100');
  expect(store.collectionName).toBe('corolet_memory');
  expect(store.collectionMetadata).toEqual({ 'hnsw:space': 'cosine' });
  expect(store.embeddings).toBeInstanceOf(CloudflareEmbeddings);
  expect(e.llm).toBeInstanceOf(ChatCloudflare);
  expect({ k: e.k, minRelevance: e.minRelevance, scoreIsDistance: e.scoreIsDistance }).toEqual({
    k: 4,
    minRelevance: 0.5,
    scoreIsDistance: true,
  });
  expect(log).toHaveBeenCalledWith('RAG ready (Chroma http://127.0.0.1:8100)');
});

test('reads every setting from the environment', async () => {
  const { e, store, log } = await init({
    CHROMA_URL: 'http://chroma:8000',
    CHROMA_COLLECTION: 'tenant_a',
    RAG_K: '8',
    RAG_MIN_RELEVANCE: '0.35',
  });
  expect(store.url).toBe('http://chroma:8000');
  expect(store.collectionName).toBe('tenant_a');
  expect(e.k).toBe(8);
  expect(e.minRelevance).toBe(0.35);
  expect(log).toHaveBeenCalledWith('RAG ready (Chroma http://chroma:8000)');
});

test('refuses to start without Cloudflare credentials', async () => {
  vi.stubEnv('CLOUDFLARE_AI_TOKEN', '');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acc');
  await expect(new RagService().onModuleInit()).rejects.toThrow(/CLOUDFLARE_AI_TOKEN/);
});
