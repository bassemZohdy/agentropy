/* global process, setTimeout */
// Worker process for multi-worker.test.ts: runs the runtime against a shared SQLite file until no work is left.
// Usage: node sqlite-worker.mjs <db path> <worker id>. Uses the built packages (run after `pnpm build`).
import { BUILTIN_PROFILES } from '../../../core/dist/index.js';
import { createLocalApp } from '../../../runtime/dist/index.js';
import { SqliteStore } from '../../../store-sqlite/dist/index.js';

const [path, workerId] = process.argv.slice(2);
const app = createLocalApp({
  store: new SqliteStore({ path }),
  pdp: { decide: async () => ({ effect: 'allow' }) },
  profiles: BUILTIN_PROFILES,
  runtime: { workerId },
  limits: { poolSize: 2 },
});
app.define(
  {
    id: 'worker',
    version: '1.0.0',
    displayName: 'worker',
    profile: { id: 'task', version: '1.0.0' },
    implementation: {
      providerId: 'native-ts',
      providerVersion: '1.0.0',
      artifact: { id: 'worker', version: '1.0.0' },
    },
    inputSchema: true,
    runtimeRequirements: { guarantees: [] },
    policyRef: { id: 'default', version: '1.0.0' },
  },
  {
    handle: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { kind: 'completed', output: { workerId } };
    },
  },
);

for (let idle = 0; idle < 3;) {
  const started = await app.runtime.tick();
  await app.runtime.idle();
  const open = await app.store.transaction(async (tx) =>
    (await tx.find('executions', {})).filter((e) =>
      ['queued', 'leased', 'running'].includes(e.value.state),
    ),
  );
  idle = open.length === 0 ? idle + 1 : 0;
  if (!started) await new Promise((r) => setTimeout(r, 10));
}
await app.store.close();
