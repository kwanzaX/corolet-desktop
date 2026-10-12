import type { Document } from '@langchain/core/documents';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { RagEngine, type RagOptions } from '../../src/rag/rag-engine.js';

/**
 * In-memory store with Chroma's contract: filter is { workspace }, score is a
 * cosine-style distance (lower is closer). Distance = 1 - share of query words
 * found in the chunk, which is enough to drive retrieval deterministically.
 */
export class WordOverlapStore {
  docs = new Map<string, Document>();
  async addDocuments(docs: Document[], opts: { ids: string[] }) {
    docs.forEach((d, i) => this.docs.set(opts.ids[i], d));
  }
  async similaritySearchWithScore(query: string, k: number, filter: { workspace: string }) {
    const words = query.toLowerCase().match(/\w+/g) ?? [];
    return [...this.docs.values()]
      .filter((d) => d.metadata.workspace === filter.workspace)
      .map((d) => {
        const text = d.pageContent.toLowerCase();
        const hit = words.filter((w) => text.includes(w)).length / Math.max(words.length, 1);
        return [d, 1 - hit] as [Document, number];
      })
      .sort((a, b) => a[1] - b[1])
      .slice(0, k);
  }
}

/** A RagEngine on the in-memory store and a scripted model; counts model calls. */
export function fakeEngine(responses: string[], opts: RagOptions & { sleep?: number } = {}) {
  const store = new WordOverlapStore();
  const llm = new FakeListChatModel({ responses, sleep: opts.sleep });
  let calls = 0;
  const original = llm._streamResponseChunks.bind(llm);
  llm._streamResponseChunks = (...args: Parameters<typeof original>) => {
    calls++;
    return original(...args);
  };
  const engine = new RagEngine(store as any, llm, { minRelevance: 0.5, chunkSize: 200, chunkOverlap: 20, ...opts });
  return { engine, store, llmCalls: () => calls };
}

export const POLICY =
  'Refund policy. You can request a full refund within 14 days of purchase. Refunds are processed through Polar.';
