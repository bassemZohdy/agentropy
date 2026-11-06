import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    setupFiles: ['./vitest.setup.ts'],
    // PGlite-backed suites (embedded WASM PostgreSQL) take seconds per test on shared CI runners.
    testTimeout: 30_000,
  },
});
