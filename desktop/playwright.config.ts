import { defineConfig, devices } from '@playwright/test';

const API = 'http://127.0.0.1:3171';

/**
 * Drives the real UI in Chromium against the real NestJS server (REST, validation,
 * Socket.IO), with only the vector store and the model replaced by fakes.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:1420', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm --prefix ../server run e2e:server',
      url: `${API}/health`,
      // Slow enough that the test can watch an answer mid-stream and stop it.
      env: { TOKEN_DELAY_MS: '60' },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:1420',
      env: { VITE_SERVER_URL: API },
      reuseExistingServer: !process.env.CI,
    },
  ],
});
