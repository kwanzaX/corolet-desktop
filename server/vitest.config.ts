import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// SWC instead of esbuild so NestJS decorators keep their design-time metadata in tests.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/main.ts', 'src/mcp.ts'] },
  },
});
