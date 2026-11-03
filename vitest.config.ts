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
  // Each test starts a fresh database and runs every migration, which can take a while on a busy machine.
  // Every test file starts its own in-memory Postgres (a few hundred MB each), so only a few run at once: the whole suite takes
  // longer but no longer fills the machine's memory.
  test: { environment: 'node', testTimeout: 60_000, hookTimeout: 60_000, maxWorkers: 2, minWorkers: 1 },
});
