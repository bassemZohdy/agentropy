// FEAT-031: the shared Store conformance suite and adapter checks on a real PostgreSQL server through
// node-postgres. Opt-in: set AGENTROPY_PG_URL (e.g. postgres://postgres:pw@127.0.0.1:55432/agentropy); without it
// the suite is skipped and the offline guard stays in force. Every store gets its own schema, dropped afterwards.
import { NOOP_TELEMETRY, type Store } from '@agentropy/core';
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

  it('a reader paging with afterSeq while writers insert concurrently never skips a row (FEAT-032.3)', async () => {
    const s = open();
    const W = 8;
    const PER = 15;
    let writing = true;
    const writers = Promise.all(
      Array.from({ length: W }, async (_, w) => {
        for (let i = 0; i < PER; i++)
          await s.transaction(async (tx) => {
            await tx.insert('outbox', `w${w}-${i}-a`, { w, i });
            // Hold the transaction open for a moment so commits interleave with other writers' allocations.
            await new Promise((r) => setTimeout(r, Math.random() * 3));
            await tx.insert('outbox', `w${w}-${i}-b`, { w, i });
          });
      }),
    ).finally(() => (writing = false));
    const seen: string[] = [];
    let cursor = 0;
    for (;;) {
      const done = !writing;
      const page = await s.transaction((tx) =>
        tx.find('outbox', { afterSeq: cursor, orderBy: 'seq' }),
      );
      for (const d of page) seen.push(d.id);
      cursor = page.at(-1)?.seq ?? cursor;
      if (done && page.length === 0) break;
    }
    await writers;
    expect(seen).toHaveLength(2 * W * PER);
    expect(new Set(seen).size).toBe(2 * W * PER);
    await s.close();
  });

  it('writers that insert concurrently do not conflict on the sequence (FEAT-032.3)', async () => {
    const counted: string[] = [];
    const telemetry = {
      ...NOOP_TELEMETRY,
      count: (name: string, _n: number, attrs?: Record<string, unknown>) =>
        void counted.push(String(attrs?.['agentropy.store.outcome'])),
    };
    const schema = `conf_${process.pid}_${Date.now().toString(36)}_${n++}`;
    created.push(schema);
    const s = new PostgresStore({
      pool: pool(),
      schema,
      ownsConnection: true,
      telemetry,
    });
    await Promise.all(
      Array.from({ length: 8 }, (_, w) =>
        s.transaction(async (tx) => {
          for (let i = 0; i < 5; i++)
            await tx.insert('effects', `w${w}-${i}`, { w, i });
        }),
      ),
    );
    // Disjoint inserts used to collide on the counter row and be retried; now none are.
    expect(counted).toEqual([]);
    const rows = await s.transaction((tx) => tx.find('effects', {}));
    expect(new Set(rows.map((r) => r.seq)).size).toBe(40);
    await s.close();
  });

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
