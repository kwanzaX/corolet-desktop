import { create } from 'zustand';
import { io as realIo, type Socket } from 'socket.io-client';

export type Source = { n: number; source: string; chunk: number; relevance: number; excerpt: string };
export type TurnState = 'streaming' | 'grounded' | 'refused' | 'stopped' | 'error';
export type Turn = { id: string; question: string; answer: string; sources: Source[]; state: TurnState };
export type Stored = { key: string; source: string; text: string; ok?: boolean };
export type Status = 'connecting' | 'connected' | 'disconnected' | 'unreachable';

export interface ChatState {
  serverUrl: string;
  workspace: string;
  status: Status;
  turns: Turn[];
  stored: Stored[];
  /** Id of the answer being streamed; one question at a time per window. */
  activeId: string | null;
  setServerUrl(url: string): void;
  setWorkspace(ws: string): void;
  connect(): void;
  ask(question: string): void;
  stop(): void;
  storeText(source: string, text: string): Promise<void>;
}

export interface Deps {
  io: (url: string) => Pick<Socket, 'on' | 'emit' | 'close' | 'connected'>;
  fetch: typeof fetch;
  uuid: () => string;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  defaultServer: string;
}

function safeGet(storage: Deps['storage'], key: string) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function safeSet(storage: Deps['storage'], key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {}
}

/**
 * All app state and server I/O. Components only read state and call actions,
 * so the streaming protocol is tested here without rendering anything.
 */
export function createChatStore(deps: Deps) {
  let socket: ReturnType<Deps['io']> | null = null;

  return create<ChatState>()((set, get) => {
    /** Applies a server event to the turn it belongs to; events for other ids are ignored. */
    const patch = (id: string, fn: (t: Turn) => Partial<Turn>) =>
      set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...fn(t) } : t)) }));
    const finish = (id: string) => set((s) => (s.activeId === id ? { activeId: null } : {}));

    return {
      serverUrl: safeGet(deps.storage, 'server') ?? deps.defaultServer,
      workspace: safeGet(deps.storage, 'workspace') ?? 'demo',
      status: 'disconnected',
      turns: [],
      stored: [],
      activeId: null,

      setServerUrl(url) {
        set({ serverUrl: url.trim() });
        safeSet(deps.storage, 'server', url.trim());
        get().connect();
      },

      setWorkspace(ws) {
        set({ workspace: ws.trim() });
        safeSet(deps.storage, 'workspace', ws.trim());
      },

      connect() {
        socket?.close();
        set({ status: 'connecting' });
        const s = (socket = deps.io(get().serverUrl));
        s.on('connect', () => set({ status: 'connected' }));
        s.on('disconnect', () => set({ status: 'disconnected' }));
        s.on('connect_error', () => set({ status: 'unreachable' }));
        s.on('sources', (e: { id: string; sources: Source[] }) => patch(e.id, () => ({ sources: e.sources })));
        s.on('token', (e: { id: string; text: string }) => patch(e.id, (t) => ({ answer: t.answer + e.text })));
        s.on('done', (e: { id: string; grounded: boolean; cancelled?: boolean }) => {
          patch(e.id, () => ({ state: e.cancelled ? 'stopped' : e.grounded ? 'grounded' : 'refused' }));
          finish(e.id);
        });
        s.on('error', (e: { id?: string; message: string }) => {
          if (!e.id) return;
          patch(e.id, () => ({ answer: e.message, state: 'error' }));
          finish(e.id);
        });
      },

      ask(question) {
        const q = question.trim();
        const { workspace, activeId } = get();
        if (!q || !socket?.connected || activeId) return;
        const id = deps.uuid();
        set((s) => ({
          activeId: id,
          turns: [...s.turns, { id, question: q, answer: '', sources: [], state: 'streaming' }],
        }));
        socket.emit('ask', { id, workspace, question: q });
      },

      stop() {
        const id = get().activeId;
        if (id) socket?.emit('cancel', { id });
      },

      async storeText(source, text) {
        const key = deps.uuid();
        set((s) => ({ stored: [{ key, source, text: 'storing…' }, ...s.stored] }));
        const update = (text: string, ok: boolean) =>
          set((s) => ({ stored: s.stored.map((x) => (x.key === key ? { ...x, text, ok } : x)) }));
        try {
          const res = await deps.fetch(`${get().serverUrl}/documents`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: get().workspace, source, text }),
          });
          const body = await res.json();
          if (res.ok) update(`${body.chunks} ${body.chunks === 1 ? 'chunk' : 'chunks'} stored`, true);
          else update(([] as string[]).concat(body.message).join(', '), false);
        } catch {
          update('server unreachable', false);
        }
      },
    };
  });
}

export const useChat = createChatStore({
  io: (url) => realIo(url, { transports: ['websocket'], reconnectionDelayMax: 5000 }),
  fetch: (...args) => fetch(...args),
  uuid: () => crypto.randomUUID(),
  storage: typeof localStorage === 'undefined' ? undefined : localStorage,
  defaultServer: import.meta.env.VITE_SERVER_URL ?? 'http://127.0.0.1:3071',
});
