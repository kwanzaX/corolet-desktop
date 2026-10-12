import { describe, expect, test } from 'vitest';
import { Document } from '@langchain/core/documents';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { NOT_FOUND, RagEngine, chunkText, type AnswerEvent } from '../src/rag/rag-engine.js';
import { POLICY, fakeEngine } from './support/fakes.js';

async function collect(gen: AsyncGenerator<AnswerEvent>) {
  const events: AnswerEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** A store that returns fixed hits and records what it was asked. */
function fixedStore(hits: [Document, number][]) {
  const seen: { k?: number; filter?: unknown } = {};
  return {
    seen,
    async addDocuments(_docs: Document[], _opts?: unknown) {},
    async similaritySearchWithScore(_q: string, k: number, filter: unknown) {
      Object.assign(seen, { k, filter });
      return hits;
    },
  };
}
const doc = (source: string, chunk?: number) =>
  new Document({ pageContent: `text of ${source}`, metadata: chunk === undefined ? { source } : { source, chunk } });

describe('ingest', () => {
  test('splits text and tags every chunk with workspace, source and position', async () => {
    const { engine, store } = fakeEngine(['x']);
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about refunds and credits.`).join(' ');
    const { chunks } = await engine.ingest({ workspace: ' acme ', source: ' faq.md ', text: long });
    expect(chunks).toBeGreaterThan(1);
    expect(chunks).toBe(store.docs.size);
    const ids = [...store.docs.keys()];
    expect(ids).toEqual(Array.from({ length: chunks }, (_, i) => `acme::faq.md::${i}`));
    [...store.docs.values()].forEach((d, i) => {
      expect(d.metadata).toMatchObject({ workspace: 'acme', source: 'faq.md', chunk: i });
    });
  });

  test('re-ingesting the same source replaces chunks instead of duplicating them', async () => {
    const { engine, store } = fakeEngine(['x']);
    await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
    await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
    expect(store.docs.size).toBe(1);
  });

  test.each([
    { workspace: ' ', source: 'a', text: 'x' },
    { workspace: 'a', source: ' ', text: 'x' },
    { workspace: 'a', source: 'a', text: '   ' },
  ])('rejects empty input %o', async (input) => {
    const { engine } = fakeEngine(['x']);
    await expect(engine.ingest(input)).rejects.toThrow('workspace, source and text are required');
  });

  test('uses 800/120 chunking by default', async () => {
    const store = fixedStore([]);
    const added: Document[] = [];
    store.addDocuments = async (docs: Document[]) => void added.push(...docs);
    const engine = new RagEngine(store as any, new FakeListChatModel({ responses: ['x'] }));
    await engine.ingest({ workspace: 'w', source: 's', text: 'word '.repeat(150) });
    expect(added).toHaveLength(1);
    added.length = 0;
    await engine.ingest({ workspace: 'w', source: 's', text: 'word '.repeat(170) });
    expect(added).toHaveLength(2);
    expect(added[0].pageContent.length).toBeGreaterThan(780);
    // The second chunk repeats about 120 characters of the first.
    expect(added[1].pageContent.length).toBeGreaterThan(150);
    expect(added[1].pageContent.length).toBeLessThan(200);
  });
});

describe('retrieve', () => {
  test('never crosses workspaces', async () => {
    const { engine } = fakeEngine(['x']);
    await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
    expect(await engine.retrieve('acme', 'refund within days')).toHaveLength(1);
    expect(await engine.retrieve('globex', 'refund within days')).toHaveLength(0);
  });

  test('converts distance to relevance and drops weak matches', async () => {
    const { engine } = fakeEngine(['x']);
    await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
    const [s] = await engine.retrieve('acme', 'refund days');
    expect(s).toMatchObject({ n: 1, source: 'policy.md', chunk: 0, relevance: 1, excerpt: POLICY });
    expect(await engine.retrieve('acme', 'who founded the company in paris')).toHaveLength(0);
  });

  test('defaults: k = 4, filter { workspace }, distance scores, threshold 0.5 inclusive', async () => {
    const store = fixedStore([
      [doc('far.md', 1), 0.6],
      [doc('edge.md', 2), 0.5],
      [doc('near.md'), 0.1],
    ]);
    const engine = new RagEngine(store as any, new FakeListChatModel({ responses: ['x'] }));
    const out = await engine.retrieve('acme', 'q');
    expect(store.seen).toEqual({ k: 4, filter: { workspace: 'acme' } });
    expect(out.map((s) => [s.n, s.source, s.chunk])).toEqual([
      [1, 'near.md', 0],
      [2, 'edge.md', 2],
    ]);
    expect(out[0].relevance).toBeCloseTo(0.9);
  });

  test('honours k, a custom filter and similarity scores', async () => {
    const store = fixedStore([
      [doc('low.md'), 0.2],
      [doc('high.md'), 0.95],
      [doc('mid.md'), 0.7],
    ]);
    const engine = new RagEngine(store as any, new FakeListChatModel({ responses: ['x'] }), {
      k: 2,
      scoreIsDistance: false,
      minRelevance: 0.6,
      filterFor: (w) => ({ where: { ws: w } }),
    });
    const out = await engine.retrieve('acme', 'q');
    expect(store.seen).toEqual({ k: 2, filter: { where: { ws: 'acme' } } });
    expect(out.map((s) => [s.n, s.source, s.relevance])).toEqual([
      [1, 'high.md', 0.95],
      [2, 'mid.md', 0.7],
    ]);
  });
});

describe('answer', () => {
  test('with nothing relevant, refuses and never calls the model', async () => {
    const { engine, llmCalls } = fakeEngine(['x']);
    await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
    const events = await collect(engine.answer('acme', 'who founded the company in paris'));
    expect(events).toEqual([
      { type: 'sources', sources: [] },
      { type: 'token', text: NOT_FOUND },
      { type: 'done', grounded: false },
    ]);
    expect(llmCalls()).toBe(0);
  });

  test('streams sources first, then tokens, then done', async () => {
    const { engine, llmCalls } = fakeEngine(['You have 14 days [1].']);
    await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
    const events = await collect(engine.answer('acme', 'how many days for a refund'));
    expect(events[0]).toMatchObject({ type: 'sources', sources: [{ source: 'policy.md' }] });
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.map((e: any) => e.text).join('')).toBe('You have 14 days [1].');
    expect(events.at(-1)).toEqual({ type: 'done', grounded: true });
    expect(llmCalls()).toBe(1);
  });

  test('sends the numbered, cited context and the question to the model', async () => {
    const { engine } = fakeEngine(['ok']);
    const prompts: string[] = [];
    const roles: string[][] = [];
    const llm = (engine as any).llm as FakeListChatModel;
    const original = llm._streamResponseChunks.bind(llm);
    llm._streamResponseChunks = (messages, ...rest) => {
      roles.push(messages.map((m) => m._getType()));
      prompts.push(messages.map((m) => String(m.content)).join('\n---\n'));
      return original(messages, ...rest);
    };
    await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
    await engine.ingest({ workspace: 'acme', source: 'refunds.md', text: 'Refund days: fourteen.' });
    await engine.ask('acme', 'how many days for a refund');
    expect(roles[0]).toEqual(['system', 'human']);
    expect(prompts[0]).toContain('You answer questions using ONLY the numbered context below. ');
    expect(prompts[0]).toContain('Cite the passages you used as [1], [2] and so on. ');
    expect(prompts[0]).toMatch(/\[1\] \(\w+\.md\) [^\n]+\n\n\[2\] \(\w+\.md\) /);
    expect(prompts[0]).toContain(`(policy.md) ${POLICY}`);
    expect(prompts[0]).toContain(`reply exactly: "${NOT_FOUND}"`);
    expect(prompts[0]).toMatch(/---\nhow many days for a refund$/);
  });

  test('marks the answer ungrounded when the model says the context does not cover it', async () => {
    const { engine, llmCalls } = fakeEngine([NOT_FOUND]);
    await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
    const r = await engine.ask('acme', 'refund days');
    expect(llmCalls()).toBe(1);
    expect(r).toMatchObject({ grounded: false, answer: NOT_FOUND });
    expect(r.sources).toHaveLength(1);
  });

  test('ask returns the trimmed answer with its sources', async () => {
    const { engine } = fakeEngine(['  14 days [1].  ']);
    await engine.ingest({ workspace: 'acme', source: 'policy.md', text: POLICY });
    const r = await engine.ask('acme', 'refund days');
    expect(r).toMatchObject({ answer: '14 days [1].', grounded: true, sources: [{ n: 1, source: 'policy.md' }] });
  });
});

test('chunkText extracts text from every content shape providers send', () => {
  expect(chunkText('hi')).toBe('hi');
  expect(chunkText([{ type: 'text', text: 'a' }, 'b'])).toBe('ab');
  expect(chunkText({ response: 'r' })).toBe('r');
  expect(chunkText({ text: 5, response: 'r' })).toBe('r');
  expect(chunkText({ usage: { tokens: 3 } })).toBe('');
  expect(chunkText(null)).toBe('');
  expect(chunkText(undefined)).toBe('');
});
