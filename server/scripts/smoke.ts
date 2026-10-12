/**
 * End-to-end smoke test against a running server and the MCP binary:
 *   node --env-file=.env dist/main.js &   then   npm run smoke
 * Checks REST ingest, Socket.IO streaming (sources -> tokens -> done) and both MCP tools.
 */
import { io } from 'socket.io-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE = process.env.SERVER_URL ?? 'http://127.0.0.1:3071';
const WS = `smoke-${Date.now()}`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok  ${msg}`);
}

async function rest() {
  const res = await fetch(`${BASE}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace: WS,
      source: 'onboarding.md',
      text: 'New Corolet workspaces start with 30 free credits. One credit renders one minute of video. Support answers within 24 hours on weekdays.',
    }),
  });
  const body: any = await res.json();
  assert(res.ok && body.chunks >= 1, `REST ingest stored ${body.chunks} chunk(s)`);
}

async function socket() {
  const s = io(BASE, { transports: ['websocket'] });
  const events: string[] = [];
  let answer = '';
  const done = new Promise<any>((resolve, reject) => {
    s.on('sources', (e) => events.push(`sources:${e.sources.length}`));
    s.on('token', (e) => {
      events.push('token');
      answer += e.text;
    });
    s.on('done', resolve);
    s.on('error', (e) => reject(new Error(e.message)));
    setTimeout(() => reject(new Error('timeout')), 60_000);
  });
  s.emit('ask', { id: 'q1', workspace: WS, question: 'How many free credits does a new workspace get?' });
  const end = await done;
  s.close();
  const tokens = events.filter((e) => e === 'token').length;
  assert(events[0]?.startsWith('sources:'), 'Socket.IO sends sources before the answer');
  assert(tokens > 1, `Socket.IO streamed the answer in ${tokens} token events`);
  assert(end.grounded && answer.includes('30'), `streamed answer is grounded: "${answer.trim()}"`);
}

async function mcp() {
  const client = new Client({ name: 'smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: ['--env-file=.env', 'dist/mcp.js'] }));
  const { tools } = await client.listTools();
  assert(tools.some((t) => t.name === 'search_memory') && tools.some((t) => t.name === 'ingest_document'), 'MCP lists search_memory and ingest_document');
  await client.callTool({ name: 'ingest_document', arguments: { workspace: WS, source: 'sla.md', text: 'Enterprise customers get a 99.9% uptime SLA.' } });
  const r: any = await client.callTool({ name: 'search_memory', arguments: { workspace: WS, question: 'What uptime SLA do enterprise customers get?' } });
  assert(r.structuredContent?.grounded && r.structuredContent.answer.includes('99.9'), `MCP search_memory answers from the ingested document: "${r.structuredContent?.answer}"`);
  await client.close();
}

await rest();
await socket();
await mcp();
console.log('smoke: all checks passed');
