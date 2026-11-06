import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    setupFiles: ['./vitest.setup.ts'],
    // PGlite-backed suites (embedded WASM PostgreSQL) take seconds per test on shared CI runners.
    testTimeout: 30_000,
    // TASK-033.4: `vitest run --coverage` reports V8 coverage of the library sources (report only, no threshold).
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/examples/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
