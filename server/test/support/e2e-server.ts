/**
 * Backend for the desktop Playwright tests: `bun test/support/e2e-server.ts`.
 * Bun runs the TypeScript directly, decorator metadata included.
 */
import { startTestServer } from './test-server.js';

// Not PORT: Bun loads .env, where PORT is the real server's.
const port = Number(process.env.E2E_PORT ?? 3171);
await startTestServer({
  port,
  responses: ['New workspaces start with 30 free credits [1].'],
  sleep: Number(process.env.TOKEN_DELAY_MS ?? 15),
});
console.log(`e2e server on http://127.0.0.1:${port}`);
