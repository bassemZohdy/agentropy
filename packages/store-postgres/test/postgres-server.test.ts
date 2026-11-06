// FEAT-031: the shared Store conformance suite and adapter checks on a real PostgreSQL server through
// node-postgres. Opt-in: set AGENTROPY_PG_URL (e.g. postgres://postgres:pw@127.0.0.1:55432/agentropy); without it
// the suite is skipped and the offline guard stays in force. Every store gets its own schema, dropped afterwards.
import type { Store } from '@agentropy/core';
import {
  allowNetwork,
  defineStoreConformance,
  endpointOf,
} from '@agentropy/testkit';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresStore, type PgPool } from '../src/index.js';

const URL = process.env['AGENTROPY_PG_URL'];
if (URL) allowNetwork([endpointOf(URL, 5432)]); // explicit opt-in: only this database
const live = URL ? describe : describe.skip;

const created: string[] = [];
const schemaOf = new WeakMap<Store, string>();
let n = 0;
const pool = () =>
  new pg.Pool({ connectionString: URL, max: 8 }) as unknown as PgPool;

function open(
  schema = `conf_${process.pid}_${Date.now().toString(36)}_${n++}`,
) {
  const s = new PostgresStore({ pool: pool(), schema, ownsConnection: true });
  schemaOf.set(s, schema);
  if (!created.includes(schema)) created.push(schema);
  return s;
}

defineStoreConformance({ describe: live, it, expect }, 'postgres (server)', {
  create: async () => open(),
  reopen: async (s) => {
    await s.close();
    return open(schemaOf.get(s)!);
  },
});

live('PostgresStore on a server', () => {
  afterAll(async () => {
    const admin = new pg.Pool({ connectionString: URL, max: 1 });
    for (const schema of created)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  /** W concurrent transactions that each increment one hot row and insert their own row. */
  async function contend(W: number) {
    const s = open();
    await s.transaction((tx) => tx.insert('checkpoints', 'counter', { n: 0 }));
    const outcomes = await Promise.allSettled(
      Array.from({ length: W }, (_, i) =>
        s.transaction(async (tx) => {
          const c = (await tx.get<{ n: number }>('checkpoints', 'counter'))!;
          await tx.update('checkpoints', 'counter', c.revision, {
            n: c.value.n + 1,
          });
          await tx.insert('effects', `e${i}`, { taskId: 't', i });
        }),
      ),
    );
    const [counter, effects] = await s.transaction(
      async (tx) =>
        [
          await tx.get<{ n: number }>('checkpoints', 'counter'),
          await tx.find<{ i: number }>('effects', {}),
        ] as const,
    );
    await s.close();
    const committed = outcomes.filter((o) => o.status === 'fulfilled').length;
    const failures = outcomes
      .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
      .map((o) => o.reason as { code?: string; details?: { reason?: string } });
    return { committed, failures, counter, effects };
  }

  it('contention within the pool size: every transaction commits once and seq stays unique', async () => {
    const r = await contend(8);
    expect(r.failures).toEqual([]);
    expect(r.counter?.value.n).toBe(8);
    expect(r.counter?.revision).toBe(9);
    expect(r.effects.length).toBe(8);
    expect(new Set(r.effects.map((e) => e.seq)).size).toBe(8);
  }, 60_000);

  it('a hot row beyond the retry bound fails StaleRevision, never a lost or partial write', async () => {
    const r = await contend(40);
    // Each transaction either committed whole or failed with the typed serialization error.
    for (const f of r.failures)
      expect([f.code, f.details?.reason]).toEqual([
        'StaleRevision',
        'serialization',
      ]);
    expect(r.counter?.value.n).toBe(r.committed);
    expect(r.effects.length).toBe(r.committed);
    expect(r.committed).toBeGreaterThanOrEqual(8);
  }, 60_000);
});
