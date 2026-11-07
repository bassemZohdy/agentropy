import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their sources, not to `dist`: tests exercise the code coverage is measured on, and
// one package's tests count towards another's modules (TASK-037.1).
const alias = Object.fromEntries(
  [
    'core',
    'runtime',
    'store-sqlite',
    'store-postgres',
    'testkit',
    'workflow-conductor',
  ].map((p) => [
    `@agentropy/${p}`,
    fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url)),
  ]),
);

export default defineConfig({
  resolve: { alias },
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
