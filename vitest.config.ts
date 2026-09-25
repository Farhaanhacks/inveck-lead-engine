import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Next's guard against importing server code into the browser; not needed in tests.
      'server-only': path.resolve(__dirname, 'tests/empty.ts'),
    },
  },
  test: { environment: 'node', testTimeout: 60_000 },
});
