import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { NOT_FOUND } from '../src/rag/rag-engine.js';
import { RagService } from '../src/rag/rag.service.js';
import { ChatGateway } from '../src/chat/chat.gateway.js';
import { POLICY } from './support/fakes.js';
import { startTestServer } from './support/test-server.js';

/**
 * The real NestJS app (controller, gateway, validation, Socket.IO) on a random
 * port, with only RagService swapped for the in-memory store and a scripted model.
 */
let app: Awaited<ReturnType<typeof startTestServer>>;
let base: string;

beforeAll(async () => {
  app = await startTestServer({ port: 0, responses: ['You have 14 days [1].'], sleep: 5 });
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(() => app.close());

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('REST', () => {
  test('GET /health', async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('POST /documents stores chunks and POST /ask answers from them', async () => {
    const stored = await post('/documents', { workspace: 'rest', source: 'policy.md', text: POLICY });
    expect(stored.status).toBe(201);
    expect(await stored.json()).toEqual({ chunks: 1 });

    const res = await post('/ask', { workspace: 'rest', question: 'how many days for a refund' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ grounded: true, sources: [{ n: 1, source: 'policy.md' }] });
  });

  test('rejects invalid input with the reason', async () => {
    const res = await post('/documents', { workspace: 'bad space', source: '', text: 'x' });
    expect(res.status).toBe(400);
    const { message } = await res.json();
    expect(message).toEqual(
      expect.arrayContaining([expect.stringMatching(/^workspace: letters, digits/), expect.stringMatching(/^source: /)]),
    );
    expect((await post('/ask', { workspace: 'ok' })).status).toBe(400);
  });

  test('trims input before validating it', async () => {
    expect((await post('/documents', { workspace: ' rest ', source: 'p.md', text: POLICY })).status).toBe(201);
    expect((await post('/documents', { workspace: 'rest', source: '   ', text: POLICY })).status).toBe(400);
    expect((await post('/ask', { workspace: 'rest', question: '   ' })).status).toBe(400);
  });
});

describe('Socket.IO', () => {
  let socket: Socket;
  beforeAll(async () => {
    await post('/documents', { workspace: 'ws', source: 'policy.md', text: POLICY });
    socket = io(base, { transports: ['websocket'] });
    await new Promise<void>((r) => socket.once('connect', () => r()));
  });
  afterAll(() => void socket.close());

  /** Records every event for one question id until done or error. */
  function run(payload: Record<string, unknown>, onFirstToken?: () => void) {
    const id = String(payload.id ?? '');
    const events: { type: string; data: any }[] = [];
    return new Promise<typeof events>((resolve) => {
      const handlers: Record<string, (d: any) => void> = {};
      for (const type of ['sources', 'token', 'done', 'error']) {
        handlers[type] = (data) => {
          if (data.id !== id) return;
          events.push({ type, data });
          if (type === 'token' && events.filter((e) => e.type === 'token').length === 1) onFirstToken?.();
          if (type === 'done' || type === 'error') {
            for (const [t, h] of Object.entries(handlers)) socket.off(t, h);
            resolve(events);
          }
        };
        socket.on(type, handlers[type]);
      }
      socket.emit('ask', payload);
    });
  }

  test('streams sources, then tokens, then done, tagged with the question id', async () => {
    const events = await run({ id: 'q1', workspace: 'ws', question: 'how many days for a refund' });
    expect(events[0]).toMatchObject({ type: 'sources', data: { id: 'q1', sources: [{ source: 'policy.md' }] } });
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.length).toBeGreaterThan(5);
    expect(tokens.map((e) => e.data.text).join('')).toBe('You have 14 days [1].');
    expect(events.at(-1)).toMatchObject({ type: 'done', data: { id: 'q1', grounded: true } });
    // Exactly one done, and the gateway forgets the finished question.
    const late: unknown[] = [];
    socket.on('done', (d) => d.id === 'q1' && late.push(d));
    await new Promise((r) => setTimeout(r, 50));
    expect(late).toEqual([]);
    expect((app.get(ChatGateway) as any).running.size).toBe(0);
  });

  test('a failure while answering becomes an error event, not a crash', async () => {
    const rag = app.get(RagService);
    const answer = rag.engine.answer;
    rag.engine.answer = async function* () {
      throw new Error('chroma down');
    };
    try {
      const events = await run({ id: 'q5', workspace: 'ws', question: 'anything' });
      expect(events).toEqual([{ type: 'error', data: { id: 'q5', message: 'The answer could not be generated. Try again.' } }]);
      expect((app.get(ChatGateway) as any).running.size).toBe(0);
    } finally {
      rag.engine.answer = answer;
    }
  });

  test('an ask with no payload gets an error with an empty id', async () => {
    const got = new Promise<any>((r) => socket.once('error', r));
    socket.emit('ask');
    expect(await got).toEqual({ id: '', message: 'Send { id, workspace, question }.' });
    socket.emit('cancel');
  });

  test('refuses without sources when the workspace has nothing relevant', async () => {
    const events = await run({ id: 'q2', workspace: 'empty', question: 'how many days for a refund' });
    expect(events.map((e) => e.type)).toEqual(['sources', 'token', 'done']);
    expect(events[1].data.text).toBe(NOT_FOUND);
    expect(events[2].data.grounded).toBe(false);
  });

  test('cancel stops one answer early', async () => {
    const events = await run({ id: 'q3', workspace: 'ws', question: 'how many days for a refund' }, () =>
      socket.emit('cancel', { id: 'q3' }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', data: { id: 'q3', grounded: false, cancelled: true } });
    expect(events.filter((e) => e.type === 'token').length).toBeLessThan('You have 14 days [1].'.length);
  });

  test('answers an invalid request with an error event for that id', async () => {
    const events = await run({ id: 'q4', workspace: 'ws' });
    expect(events).toEqual([{ type: 'error', data: { id: 'q4', message: 'Send { id, workspace, question }.' } }]);
  });
});
