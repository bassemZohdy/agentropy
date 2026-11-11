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
    // TASK-033.4: `vitest run --coverage` reports V8 coverage of the library sources. TASK-047: it also fails below the
    // thresholds, set about 1.5 points under the 2026-11-11 baseline (93.23 % statements, 86.28 % branches, 94.02 %
    // functions, 94.68 % lines) so a real drop fails CI and platform noise does not. Raise them when the baseline rises.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/examples/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { statements: 92, branches: 85, functions: 93, lines: 93 },
    },
  },
});
