/* global process, setTimeout */
// Worker process for multi-worker.test.ts: runs the runtime against a shared SQLite file until no work is left.
// Usage: node sqlite-worker.mjs <db path> <worker id> [<barrier dir> <workers>]. Uses the built packages (run after `pnpm build`).
// With a barrier, a worker waits until every worker has started so one fast process cannot drain the queue alone.
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILTIN_PROFILES } from '../../../core/dist/index.js';
import { createLocalApp } from '../../../runtime/dist/index.js';
import { SqliteStore } from '../../../store-sqlite/dist/index.js';

const [path, workerId, barrier, workers] = process.argv.slice(2);
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
      // Long enough that SQLite's busy back-off (up to 100 ms per wait) cannot let one process drain the queue.
      await new Promise((r) => setTimeout(r, 25));
      return { kind: 'completed', output: { workerId } };
    },
  },
);

if (barrier) {
  await writeFile(join(barrier, workerId), '');
  while ((await readdir(barrier)).length < Number(workers))
    await new Promise((r) => setTimeout(r, 10));
}

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
