import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Document } from '@langchain/core/documents';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { NOT_FOUND, RagEngine, chunkText, type AnswerEvent } from '../src/rag/rag-engine.js';

/**
 * In-memory store with Chroma's contract: filter is { workspace }, score is a
 * cosine-style distance (lower is closer). Distance = 1 - share of query words
 * found in the chunk, which is enough to drive retrieval deterministically.
 */
class WordOverlapStore {
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

function setup(responses: string[] = ['You have 14 days [1].'], minRelevance = 0.5) {
  const store = new WordOverlapStore();
  const llm = new FakeListChatModel({ responses });
  let calls = 0;
  const original = llm._streamResponseChunks.bind(llm);
  llm._streamResponseChunks = (...args: Parameters<typeof original>) => {
    calls++;
    return original(...args);
  };
  const engine = new RagEngine(store as any, llm, { minRelevance, chunkSize: 200, chunkOverlap: 20 });
  return { engine, store, llmCalls: () => calls };
}

async function collect(gen: AsyncGenerator<AnswerEvent>) {
  const events: AnswerEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const POLICY = 'Refund policy. You can request a full refund within 14 days of purchase. Refunds are processed through Polar.';

test('ingest splits text and tags every chunk with workspace, source and position', async () => {
  const { engine, store } = setup();
  const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about refunds and credits.`).join(' ');
  const { chunks } = await engine.ingest({ workspace: 'acme', source: 'faq.md', text: long });
  assert.ok(chunks > 1);
  const ids = [...store.docs.keys()];
  assert.deepEqual(ids[0], 'acme::faq.md::0');
  for (const d of store.docs.values()) {
    assert.equal(d.metadata.workspace, 'acme');
    assert.equal(d.metadata.source, 'faq.md');
    assert.equal(typeof d.metadata.chunk, 'number');
  }
});

test('re-ingesting the same source replaces chunks instead of duplicating them', async () => {
  const { engine, store } = setup();
  await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
  await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
  assert.equal(store.docs.size, 1);
});

test('ingest rejects empty input', async () => {
  const { engine } = setup();
  await assert.rejects(engine.ingest({ workspace: ' ', source: 'a', text: 'x' }));
  await assert.rejects(engine.ingest({ workspace: 'a', source: 'a', text: '   ' }));
});

test('retrieval never crosses workspaces', async () => {
  const { engine } = setup();
  await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
  assert.equal((await engine.retrieve('acme', 'refund within days')).length, 1);
  assert.equal((await engine.retrieve('globex', 'refund within days')).length, 0);
});

test('distance is converted to relevance and weak matches are dropped', async () => {
  const { engine } = setup();
  await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
  const [s] = await engine.retrieve('acme', 'refund days');
  assert.equal(s.relevance, 1);
  assert.equal(s.n, 1);
  assert.equal((await engine.retrieve('acme', 'who founded the company in paris')).length, 0);
});

test('with nothing relevant, the answer is a refusal and the model is never called', async () => {
  const { engine, llmCalls } = setup();
  await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
  const events = await collect(engine.answer('acme', 'who founded the company in paris'));
  assert.deepEqual(events[0], { type: 'sources', sources: [] });
  assert.equal(events.filter((e) => e.type === 'token').map((e: any) => e.text).join(''), NOT_FOUND);
  assert.deepEqual(events.at(-1), { type: 'done', grounded: false });
  assert.equal(llmCalls(), 0);
});

test('a grounded answer streams sources first, then tokens, then done', async () => {
  const { engine, llmCalls } = setup(['You have 14 days [1].']);
  await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
  const events = await collect(engine.answer('acme', 'how many days for a refund'));
  assert.equal(events[0].type, 'sources');
  assert.ok(events.filter((e) => e.type === 'token').length > 1, 'answer is streamed in several tokens');
  assert.deepEqual(events.at(-1), { type: 'done', grounded: true });
  assert.equal(llmCalls(), 1);
});

test('when the model says it cannot find the answer, the result is marked ungrounded', async () => {
  const { engine } = setup([NOT_FOUND]);
  await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
  const r = await engine.ask('acme', 'refund through which company and how many days');
  assert.equal(r.grounded, false);
  assert.equal(r.answer, NOT_FOUND);
});

test('chunkText extracts text from every content shape providers send', () => {
  assert.equal(chunkText('hi'), 'hi');
  assert.equal(chunkText([{ type: 'text', text: 'a' }, 'b']), 'ab');
  assert.equal(chunkText({ response: 'r' }), 'r');
  assert.equal(chunkText({ usage: { tokens: 3 } }), '');
  assert.equal(chunkText(undefined), '');
});
