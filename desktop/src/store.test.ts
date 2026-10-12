import { describe, expect, test, vi } from 'vitest';
import { createChatStore, type Deps } from './store';

/** A Socket.IO stand-in: records emits and lets the test fire server events. */
function fakeSocket() {
  const handlers = new Map<string, (data?: any) => void>();
  return {
    connected: false,
    emitted: [] as [string, unknown][],
    closed: false,
    on(ev: string, fn: (data?: any) => void) {
      handlers.set(ev, fn);
      return this;
    },
    emit(ev: string, data: unknown) {
      this.emitted.push([ev, data]);
      return this;
    },
    close() {
      this.closed = true;
      return this;
    },
    fire(ev: string, data?: unknown) {
      if (ev === 'connect') this.connected = true;
      handlers.get(ev)?.(data);
    },
  };
}

function setup(over: Partial<Deps> = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const urls: string[] = [];
  let n = 0;
  const saved = new Map<string, string>();
  const store = createChatStore({
    io: (url) => {
      urls.push(url);
      const s = fakeSocket();
      sockets.push(s);
      return s as any;
    },
    fetch: vi.fn(),
    uuid: () => `id${++n}`,
    storage: { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => void saved.set(k, v) },
    defaultServer: 'http://127.0.0.1:3071',
    ...over,
  });
  const socket = () => sockets.at(-1)!;
  const connected = () => {
    store.getState().connect();
    socket().fire('connect');
  };
  return { store, sockets, socket, urls, saved, connected };
}

describe('connection', () => {
  test('tracks the socket status', () => {
    const { store, socket } = setup();
    expect(store.getState().status).toBe('disconnected');
    store.getState().connect();
    expect(store.getState().status).toBe('connecting');
    socket().fire('connect');
    expect(store.getState().status).toBe('connected');
    socket().fire('disconnect');
    expect(store.getState().status).toBe('disconnected');
    socket().fire('connect_error');
    expect(store.getState().status).toBe('unreachable');
  });

  test('a new server URL is saved and replaces the old socket', () => {
    const { store, sockets, urls, saved, connected } = setup();
    connected();
    store.getState().setServerUrl('  http://10.0.0.5:3071 ');
    expect(sockets[0].closed).toBe(true);
    expect(urls).toEqual(['http://127.0.0.1:3071', 'http://10.0.0.5:3071']);
    expect(saved.get('server')).toBe('http://10.0.0.5:3071');
  });

  test('restores server and workspace from storage, and survives storage that throws', () => {
    const remembered = setup({ storage: { getItem: (k) => ({ server: 'http://s', workspace: 'acme' })[k] ?? null, setItem() {} } });
    expect(remembered.store.getState()).toMatchObject({ serverUrl: 'http://s', workspace: 'acme' });
    const broken = setup({
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(broken.store.getState()).toMatchObject({ serverUrl: 'http://127.0.0.1:3071', workspace: 'demo' });
    expect(() => broken.store.getState().setWorkspace('x')).not.toThrow();
  });
});

describe('asking', () => {
  test('streams sources and tokens into the turn, then marks it grounded', () => {
    const { store, socket, connected } = setup();
    connected();
    store.getState().setWorkspace(' acme ');
    store.getState().ask('  how many days?  ');
    expect(socket().emitted).toEqual([['ask', { id: 'id1', workspace: 'acme', question: 'how many days?' }]]);
    expect(store.getState().activeId).toBe('id1');

    const src = { n: 1, source: 'policy.md', chunk: 0, relevance: 0.9, excerpt: '14 days' };
    socket().fire('sources', { id: 'id1', sources: [src] });
    socket().fire('token', { id: 'id1', text: '14 ' });
    socket().fire('token', { id: 'other', text: 'ignored' });
    socket().fire('token', { id: 'id1', text: 'days [1].' });
    socket().fire('done', { id: 'id1', grounded: true });

    expect(store.getState().turns).toEqual([
      { id: 'id1', question: 'how many days?', answer: '14 days [1].', sources: [src], state: 'grounded' },
    ]);
    expect(store.getState().activeId).toBeNull();
  });

  test.each([
    [{ grounded: false }, 'refused'],
    [{ grounded: false, cancelled: true }, 'stopped'],
  ])('done %o marks the turn %s', (done, state) => {
    const { store, socket, connected } = setup();
    connected();
    store.getState().ask('q');
    socket().fire('done', { id: 'id1', ...done });
    expect(store.getState().turns[0].state).toBe(state);
  });

  test('an error event replaces the answer with the message', () => {
    const { store, socket, connected } = setup();
    connected();
    store.getState().ask('q');
    socket().fire('error', { message: 'no id: ignored' });
    expect(store.getState().activeId).toBe('id1');
    socket().fire('error', { id: 'id1', message: 'The answer could not be generated.' });
    expect(store.getState().turns[0]).toMatchObject({ answer: 'The answer could not be generated.', state: 'error' });
    expect(store.getState().activeId).toBeNull();
  });

  test('ignores empty questions, a disconnected socket and a second question while one streams', () => {
    const { store, socket, connected } = setup();
    store.getState().connect();
    store.getState().ask('offline');
    expect(socket().emitted).toEqual([]);
    socket().fire('connect');
    store.getState().ask('   ');
    store.getState().ask('first');
    store.getState().ask('second');
    expect(socket().emitted.map(([, d]: any) => d.question)).toEqual(['first']);
    expect(store.getState().turns).toHaveLength(1);
  });

  test('stop cancels only the active answer', () => {
    const { store, socket, connected } = setup();
    connected();
    store.getState().stop();
    expect(socket().emitted).toEqual([]);
    store.getState().ask('q');
    store.getState().stop();
    expect(socket().emitted.at(-1)).toEqual(['cancel', { id: 'id1' }]);
  });
});

describe('storing documents', () => {
  const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

  test('posts to /documents and reports the chunk count', async () => {
    const fetch = vi.fn(() => json(201, { chunks: 3 }));
    const { store } = setup({ fetch: fetch as any });
    store.getState().setWorkspace('acme');
    const pending = store.getState().storeText('faq.md', 'text');
    expect(store.getState().stored[0]).toEqual({ key: 'id1', source: 'faq.md', text: 'storing…' });
    await pending;
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3071/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'acme', source: 'faq.md', text: 'text' }),
    });
    expect(store.getState().stored[0]).toMatchObject({ text: '3 chunks stored', ok: true });
  });

  test('says "chunk" for one, newest first', async () => {
    const fetch = vi.fn(() => json(201, { chunks: 1 }));
    const { store } = setup({ fetch: fetch as any });
    await store.getState().storeText('a.md', 'x');
    await store.getState().storeText('b.md', 'y');
    expect(store.getState().stored.map((s) => `${s.source}: ${s.text}`)).toEqual(['b.md: 1 chunk stored', 'a.md: 1 chunk stored']);
  });

  test('shows validation messages and network failures', async () => {
    const fetch = vi
      .fn()
      .mockReturnValueOnce(json(400, { message: ['workspace: invalid', 'text: required'] }))
      .mockReturnValueOnce(json(500, { message: 'Internal server error' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { store } = setup({ fetch });
    await store.getState().storeText('a', 'x');
    await store.getState().storeText('b', 'x');
    await store.getState().storeText('c', 'x');
    expect(store.getState().stored.map((s) => [s.text, s.ok])).toEqual([
      ['server unreachable', false],
      ['Internal server error', false],
      ['workspace: invalid, text: required', false],
    ]);
  });
});
