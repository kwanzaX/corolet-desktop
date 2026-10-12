import { io, type Socket } from 'socket.io-client';

type Source = { n: number; source: string; chunk: number; relevance: number; excerpt: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const serverEl = $<HTMLInputElement>('server');
const workspaceEl = $<HTMLInputElement>('workspace');
const statusEl = $('status');
const logEl = $('log');
const form = $<HTMLFormElement>('ask-form');
const questionEl = $<HTMLInputElement>('question');
const sendBtn = $<HTMLButtonElement>('send');
const stopBtn = $<HTMLButtonElement>('stop');
const addedEl = $('added');
const inTauri = '__TAURI_INTERNALS__' in window;

// Remember the last server and workspace between launches.
for (const el of [serverEl, workspaceEl]) {
  try {
    el.value = localStorage.getItem(el.id) ?? el.value;
  } catch {}
  el.addEventListener('change', () => {
    try {
      localStorage.setItem(el.id, el.value.trim());
    } catch {}
    if (el === serverEl) connect();
  });
}

let socket: Socket | null = null;
let current: { id: string; answer: HTMLElement; sources: HTMLElement } | null = null;

function setStatus(state: 'on' | 'off' | 'wait', text: string) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function connect() {
  socket?.close();
  setStatus('wait', 'Connecting…');
  socket = io(serverEl.value.trim(), { transports: ['websocket'], reconnectionDelayMax: 5000 });
  socket.on('connect', () => setStatus('on', 'Connected'));
  socket.on('disconnect', () => setStatus('off', 'Disconnected'));
  socket.on('connect_error', () => setStatus('off', 'Server unreachable'));

  socket.on('sources', (e: { id: string; sources: Source[] }) => {
    if (e.id !== current?.id) return;
    current.sources.replaceChildren(
      ...e.sources.map((s) => {
        const li = document.createElement('li');
        li.innerHTML = `<b>[${s.n}]</b> ${escapeHtml(s.source)} <span class="rel">${s.relevance.toFixed(2)}</span>`;
        li.title = s.excerpt;
        return li;
      }),
    );
  });
  socket.on('token', (e: { id: string; text: string }) => {
    if (e.id !== current?.id) return;
    current.answer.textContent += e.text;
    logEl.scrollTop = logEl.scrollHeight;
  });
  socket.on('done', (e: { id: string; grounded: boolean; cancelled?: boolean }) => {
    if (e.id !== current?.id) return;
    current.answer.dataset.grounded = String(e.grounded);
    if (e.cancelled) current.answer.textContent += ' (stopped)';
    finish();
  });
  socket.on('error', (e: { id?: string; message: string }) => {
    if (current && e.id === current.id) {
      current.answer.textContent = e.message;
      current.answer.dataset.grounded = 'error';
      finish();
    }
  });
}

function finish() {
  current = null;
  sendBtn.disabled = false;
  stopBtn.hidden = true;
  questionEl.focus();
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const question = questionEl.value.trim();
  if (!question || !socket?.connected || current) return;
  const turn = document.createElement('article');
  turn.className = 'turn';
  turn.innerHTML = `<p class="q"></p><p class="a"></p><ol class="sources"></ol>`;
  turn.querySelector('.q')!.textContent = question;
  logEl.append(turn);
  current = {
    id: crypto.randomUUID(),
    answer: turn.querySelector('.a') as HTMLElement,
    sources: turn.querySelector('.sources') as HTMLElement,
  };
  socket.emit('ask', { id: current.id, workspace: workspaceEl.value.trim(), question });
  questionEl.value = '';
  sendBtn.disabled = true;
  stopBtn.hidden = false;
});

stopBtn.addEventListener('click', () => {
  if (current) socket?.emit('cancel', { id: current.id });
});

async function store(source: string, text: string) {
  const li = document.createElement('li');
  li.textContent = `${source}: storing…`;
  addedEl.prepend(li);
  try {
    const res = await fetch(`${serverEl.value.trim()}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: workspaceEl.value.trim(), source, text }),
    });
    const body = await res.json();
    li.textContent = res.ok ? `${source}: ${body.chunks} chunks stored` : `${source}: ${[].concat(body.message).join(', ')}`;
    li.dataset.ok = String(res.ok);
  } catch {
    li.textContent = `${source}: server unreachable`;
    li.dataset.ok = 'false';
  }
}

// Native file dialog inside Tauri; a plain file input when opened in a browser.
$('pick').addEventListener('click', async () => {
  if (inTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const picked = await open({ multiple: true, filters: [{ name: 'Text', extensions: ['md', 'txt'] }] });
    for (const path of ([] as string[]).concat(picked ?? [])) {
      await store(path.split(/[\\/]/).pop()!, await readTextFile(path));
    }
    return;
  }
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.md,.txt' });
  input.onchange = async () => {
    for (const f of Array.from(input.files ?? [])) await store(f.name, await f.text());
  };
  input.click();
});

$('paste-save').addEventListener('click', async () => {
  const source = $<HTMLInputElement>('paste-source').value.trim() || 'pasted.md';
  const text = $<HTMLTextAreaElement>('paste-text').value;
  if (text.trim()) await store(source, text);
});

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

connect();
