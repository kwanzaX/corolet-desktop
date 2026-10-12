import { afterEach, describe, expect, test, vi } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatCloudflare, CloudflareEmbeddings, cloudflareConfigFromEnv, createChatModel } from '../src/ai/cloudflare.js';

const cfg = { accountId: 'acc', token: 'tok', embeddingModel: '@cf/emb', chatModel: '@cf/chat' };

/** A fetch Response whose body arrives in the given pieces, like a real SSE stream. */
function sse(pieces: (string | Uint8Array)[], status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(typeof p === 'string' ? enc.encode(p) : p);
      c.close();
    },
  });
  return new Response(body, { status });
}
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function mockFetch(...responses: Response[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('cloudflareConfigFromEnv', () => {
  test('requires both credentials', () => {
    expect(() => cloudflareConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a' })).toThrow(/CLOUDFLARE_AI_TOKEN/);
    expect(() => cloudflareConfigFromEnv({ CLOUDFLARE_AI_TOKEN: 't' })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  test('uses bge-base and Llama 3.1 8B unless overridden', () => {
    expect(cloudflareConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_AI_TOKEN: 't' })).toEqual({
      accountId: 'a',
      token: 't',
      embeddingModel: '@cf/baai/bge-base-en-v1.5',
      chatModel: '@cf/meta/llama-3.1-8b-instruct',
    });
    expect(
      cloudflareConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_AI_TOKEN: 't', EMBEDDING_MODEL: 'e', CHAT_MODEL: 'c' }),
    ).toMatchObject({ embeddingModel: 'e', chatModel: 'c' });
  });
});

describe('CloudflareEmbeddings', () => {
  const ok = (n: number) => Response.json({ success: true, result: { data: Array.from({ length: n }, (_, i) => [i]) } });

  test('posts batches of 50 to the embedding model and keeps the order', async () => {
    const fetch = mockFetch(ok(50), ok(50), ok(20));
    const texts = Array.from({ length: 120 }, (_, i) => `t${i}`);
    const vectors = await new CloudflareEmbeddings(cfg, { maxRetries: 0 }).embedDocuments(texts);
    expect(vectors).toHaveLength(120);
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/emb');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body).text).toEqual(texts.slice(0, 50));
    expect(JSON.parse(fetch.mock.calls[2][1].body).text).toEqual(texts.slice(100));
  });

  test('an exact multiple of the batch size makes no extra request', async () => {
    const fetch = mockFetch(ok(50), ok(50));
    await new CloudflareEmbeddings(cfg, { maxRetries: 0 }).embedDocuments(Array.from({ length: 100 }, () => 't'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('embedQuery returns a single vector', async () => {
    mockFetch(Response.json({ success: true, result: { data: [[0.1, 0.2]] } }));
    expect(await new CloudflareEmbeddings(cfg, { maxRetries: 0 }).embedQuery('q')).toEqual([0.1, 0.2]);
  });

  test('surfaces the API error message', async () => {
    mockFetch(Response.json({ success: false, errors: [{ message: 'quota exceeded' }] }, { status: 429 }));
    await expect(new CloudflareEmbeddings(cfg, { maxRetries: 0 }).embedQuery('q')).rejects.toThrow(
      'Cloudflare embeddings failed: quota exceeded',
    );
  });

  test('reports the HTTP status when the body is not JSON', async () => {
    mockFetch(new Response('bad gateway', { status: 502 }));
    await expect(new CloudflareEmbeddings(cfg, { maxRetries: 0 }).embedQuery('q')).rejects.toThrow(
      'Cloudflare embeddings failed: HTTP 502',
    );
  });

  test('falls back to the status when the error list is empty', async () => {
    mockFetch(Response.json({ success: false, errors: [] }, { status: 500 }));
    await expect(new CloudflareEmbeddings(cfg, { maxRetries: 0 }).embedQuery('q')).rejects.toThrow(
      'Cloudflare embeddings failed: HTTP 500',
    );
  });

  test('treats a 200 without success as a failure', async () => {
    mockFetch(Response.json({ success: false }));
    await expect(new CloudflareEmbeddings(cfg, { maxRetries: 0 }).embedQuery('q')).rejects.toThrow('HTTP 200');
  });
});

describe('ChatCloudflare', () => {
  const model = () => new ChatCloudflare(cfg, { maxRetries: 0 });

  test('streams OpenAI-style deltas even when events are split across network chunks', async () => {
    const stream = delta('Hel') + delta('') + delta('lo') + 'data: [DONE]\n\n' + delta('ignored');
    mockFetch(sse([stream.slice(0, 7), stream.slice(7, 40), stream.slice(40)]));
    const out: string[] = [];
    for await (const c of await model().stream([new HumanMessage('hi')])) out.push(String(c.content));
    expect(out).toEqual(['Hel', 'lo']);
  });

  test('decodes multi-byte characters split between network chunks, with CRLF line endings', async () => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Olá, João' } }] })}\r\n`);
    const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte "á"
    mockFetch(sse([bytes.slice(0, cut), bytes.slice(cut)]));
    expect((await model().invoke([new HumanMessage('hi')])).content).toBe('Olá, João');
  });

  test('falls back to { response } when choices carry no delta, and ignores non-string responses', async () => {
    mockFetch(
      sse([
        'data: {"choices":[],"response":"A"}\n',
        'data: {"choices":[{}],"response":"B"}\n',
        'data: null\n',
        'data: {"response":5}\n',
        delta('C'),
      ]),
    );
    expect((await model().invoke([new HumanMessage('hi')])).content).toBe('ABC');
  });

  test('accepts the native { response } shape and skips keep-alives, empty and malformed lines', async () => {
    mockFetch(
      sse([': keep-alive\n', 'data: {not json}\n', delta(''), 'data: {"response":"A"}\n', 'event: x\n', delta('B'), 'data: {"usage":{}}\n']),
    );
    const res = await model().invoke([new HumanMessage('hi')]);
    expect(res.content).toBe('AB');
  });

  test('sends roles, the stream flag and a token limit', async () => {
    const fetch = mockFetch(sse([delta('ok')]));
    await model().invoke([new SystemMessage('sys'), new HumanMessage('q'), new AIMessage('a')]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/chat');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      stream: true,
      max_tokens: 700,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    });
  });

  test('serialises non-string content instead of dropping it', async () => {
    const fetch = mockFetch(sse([delta('ok')]));
    await model().invoke([new HumanMessage({ content: [{ type: 'text', text: 'hi' }] })]);
    expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].content).toBe('[{"type":"text","text":"hi"}]');
  });

  test('fails with the status and body on an HTTP error', async () => {
    mockFetch(new Response('model overloaded', { status: 503 }));
    await expect(model().invoke([new HumanMessage('hi')])).rejects.toThrow('Cloudflare chat failed: HTTP 503 model overloaded');
    mockFetch(new Response('', { status: 500 }));
    await expect(model().invoke([new HumanMessage('hi')])).rejects.toThrow(/^Cloudflare chat failed: HTTP 500$/);
  });

  test('reports its type and is what createChatModel builds', () => {
    expect(model()._llmType()).toBe('cloudflare-workers-ai');
    const built = createChatModel(cfg);
    expect(built).toBeInstanceOf(ChatCloudflare);
    expect((built as any).caller.maxRetries).toBe(2);
  });
});
