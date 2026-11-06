// FEAT-028.1: PostgreSQL adapter — the shared Store conformance suite on embedded PGlite (real PostgreSQL compiled
// to WASM, offline), durable reopen, schema version guard, serialization-conflict retry and error redaction.
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { METRICS, NOOP_TELEMETRY, type Store } from '@agentropy/core';
import { defineStoreConformance } from '@agentropy/testkit';
import { describe, expect, it } from 'vitest';
import {
  PostgresStore,
  SCHEMA_VERSION,
  type PgClient,
  type PgPool,
} from '../src/index.js';

const dirs = new WeakMap<Store, string>();

async function durable(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), 'agentropy-pg-'));
  const s = new PostgresStore({
    client: new PGlite(dir),
    ownsConnection: true,
  });
  dirs.set(s, dir);
  return s;
}

defineStoreConformance({ describe, it, expect }, 'postgres (PGlite)', {
  create: durable,
  reopen: async (s) => {
    const dir = dirs.get(s)!;
    await s.close();
    return new PostgresStore({ client: new PGlite(dir), ownsConnection: true });
  },
});

// The same contract with every write sent at the call (FEAT-032.2 switched off).
defineStoreConformance(
  { describe, it, expect },
  'postgres (PGlite, unbatched)',
  {
    create: async () =>
      new PostgresStore({
        client: new PGlite(),
        ownsConnection: true,
        batchWrites: false,
      }),
  },
);

/** A PGlite client that records every statement it is sent. */
function traced() {
  const db = new PGlite();
  const sent: string[] = [];
  const client: PgClient = {
    query: (text, params) => {
      sent.push(text);
      return db.query(text, params);
    },
  };
  return { db, sent, client };
}

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );

describe('PostgresStore', () => {
  it('orders strings by code unit and keeps numeric index fields numeric', async () => {
    const s = new PostgresStore({ client: new PGlite(), ownsConnection: true });
    await s.transaction(async (tx) => {
      await tx.insert('outbox', 'o10', { published: 10, aggregateId: 'b' });
      await tx.insert('outbox', 'o9', { published: 9, aggregateId: 'B' });
      await tx.insert('outbox', 'oF', { published: false, aggregateId: 'a' });
    });
    const ids = async (p: Promise<{ id: string }[]>) =>
      (await p).map((d) => d.id);
    expect(
      await ids(
        s.transaction((tx) => tx.find('outbox', { orderBy: 'published' })),
      ),
    ).toEqual(['oF', 'o9', 'o10']);
    expect(
      await ids(
        s.transaction((tx) => tx.find('outbox', { orderBy: 'aggregateId' })),
      ),
    ).toEqual(['o9', 'oF', 'o10']);
    expect(
      await ids(
        s.transaction((tx) =>
          tx.find('outbox', { range: { field: 'published', gte: 9 } }),
        ),
      ),
    ).toEqual(['o10', 'o9']);
    expect(
      await ids(
        s.transaction((tx) => tx.find('outbox', { where: { published: 0 } })),
      ),
    ).toEqual(['oF']);
    await s.close();
  });

  it('two stores on one database keep separate schemas', async () => {
    const db = new PGlite();
    const a = new PostgresStore({ client: db, schema: 'app_a' });
    const b = new PostgresStore({ client: db, schema: 'app_b' });
    await a.transaction((tx) => tx.insert('tasks', 't1', { tenantId: 'x' }));
    expect(await b.transaction((tx) => tx.get('tasks', 't1'))).toBeUndefined();
    expect(
      await code(
        Promise.resolve().then(
          () => new PostgresStore({ client: db, schema: 'X; drop' }),
        ),
      ),
    ).toBe('InvalidConfiguration');
    await db.close();
  });

  it('schema 2 continues seq after the schema-1 counter; inserted rows carry their final seq after commit', async () => {
    const db = new PGlite();
    await new PostgresStore({ client: db }).migrate();
    // Turn the database back into schema 1 with 41 rows' worth of counter.
    await db.query('DROP SEQUENCE agentropy.seq');
    await db.query('DELETE FROM agentropy.schema_migrations WHERE version = 2');
    await db.query("UPDATE agentropy.meta SET value = 41 WHERE key = 'seq'");
    const s = new PostgresStore({ client: db });
    const a = await s.transaction(async (tx) => {
      const doc = await tx.insert('sessions', 'a', {});
      const inTx = (await tx.find('sessions', {}))[0]!.seq;
      return { doc, inTx };
    });
    expect(a.doc.seq).toBe(42);
    expect(a.inTx).toBeGreaterThan(Number.MAX_SAFE_INTEGER / 4); // provisional inside its own transaction
    const b = await s.transaction(async (tx) => [
      await tx.insert('sessions', 'b', {}),
      await tx.insert('tasks', 'c', { status: 'created' }),
    ]);
    expect(b.map((d) => d.seq)).toEqual([43, 44]);
    expect((await s.transaction((tx) => tx.get('tasks', 'c')))?.seq).toBe(44);
    await db.close();
  });

  it('refuses a database migrated by a newer adapter', async () => {
    const db = new PGlite();
    await new PostgresStore({ client: db }).migrate();
    await db.query(
      'INSERT INTO agentropy.schema_migrations (version) VALUES ($1)',
      [SCHEMA_VERSION + 1],
    );
    expect(
      await code(
        new PostgresStore({ client: db }).transaction((tx) =>
          tx.get('tasks', 'x'),
        ),
      ),
    ).toBe('IncompatibleVersion');
    await db.close();
  });

  it('re-runs a transaction after a serialization failure; gives up as StaleRevision', async () => {
    const db = new PGlite();
    let failCommits = 0;
    let locks = 0;
    const flaky: PgClient = {
      query: async (text, params) => {
        if (text.includes('pg_advisory_lock(')) locks++;
        if (text === 'COMMIT' && failCommits-- > 0) {
          await db.query('ROLLBACK');
          throw Object.assign(new Error('could not serialize access'), {
            code: '40001',
          });
        }
        return db.query(text, params);
      },
    };
    const s = new PostgresStore({ client: flaky });
    await s.migrate();
    failCommits = 2;
    let runs = 0;
    await s.transaction(async (tx) => {
      runs++;
      await tx.insert('sessions', 's1', { n: runs });
    });
    expect(runs).toBe(3);
    // FEAT-032.2: the second re-run queues behind other repeat losers.
    expect(locks).toBe(1);
    expect(
      (await s.transaction((tx) => tx.get<{ n: number }>('sessions', 's1')))
        ?.value.n,
    ).toBe(3);

    const counted: [string, number, Record<string, unknown> | undefined][] = [];
    const telemetry = {
      ...NOOP_TELEMETRY,
      count: (name: string, n: number, attrs?: Record<string, unknown>) =>
        void counted.push([name, n, attrs]),
    };
    const capped = new PostgresStore({
      client: flaky,
      maxRetries: 1,
      telemetry,
    });
    await capped.migrate();
    failCommits = 100;
    expect(
      await code(capped.transaction((tx) => tx.insert('sessions', 's2', {}))),
    ).toBe('StaleRevision');
    // FEAT-032.1: one retried conflict, then the exhausted one.
    expect(counted).toEqual(
      ['retried', 'exhausted'].map((outcome) => [
        METRICS.storeConflicts,
        1,
        {
          'agentropy.store.adapter': 'postgres',
          'agentropy.store.outcome': outcome,
          'agentropy.store.sqlstate': '40001',
        },
      ]),
    );
    await db.close();
  });

  it('never surfaces raw database errors: SQL text stays inside; connection loss is retryable', async () => {
    const db = new PGlite();
    const broken = (sqlstate: string): PgClient => ({
      query: async (text, params) => {
        if (text.startsWith('SELECT id')) {
          throw Object.assign(
            new Error(`boom near "secret_column" in ${text}`),
            {
              code: sqlstate,
            },
          );
        }
        return db.query(text, params);
      },
    });
    const err = await new PostgresStore({ client: broken('42703') })
      .transaction((tx) => tx.get('tasks', 'x'))
      .catch(
        (e: unknown) =>
          e as { code: string; message: string; details: unknown },
      );
    expect(err).toMatchObject({
      code: 'Internal',
      message: 'Database error',
      details: { sqlstate: '42703' },
    });
    expect(JSON.stringify(err)).not.toContain('secret_column');
    expect(
      await code(
        new PostgresStore({
          client: broken('08006'),
          schema: 'other',
        }).transaction((tx) => tx.get('tasks', 'x')),
      ),
    ).toBe('ProviderUnavailable');
    await db.close();
  });

  it('buffers writes: one statement before COMMIT, own writes visible to later reads (FEAT-032.2)', async () => {
    const { db, sent, client } = traced();
    const s = new PostgresStore({ client });
    await s.transaction((tx) => tx.insert('sessions', 'seen', { n: 0 }));
    sent.length = 0;
    const out = await s.transaction(async (tx) => {
      const head = (await tx.get<{ n: number }>('sessions', 'seen'))!;
      const t = await tx.insert('tasks', 't1', { status: 'created' });
      const t2 = await tx.update('tasks', 't1', t.revision, {
        status: 'running',
      });
      await tx.insert('outbox', 'e1', { published: 0, aggregateId: 't1' });
      const h = await tx.update('sessions', 'seen', head.revision, { n: 1 });
      return { t2, h };
    });
    // BEGIN, the read, one statement with every write, one for the seq block (an update is buffered), COMMIT.
    expect(sent).toHaveLength(5);
    expect([out.t2.revision, out.t2.seq, out.h.revision]).toEqual([
      2,
      out.t2.seq,
      2,
    ]);
    const after = await s.transaction(async (tx) => [
      await tx.get('tasks', 't1'),
      await tx.get('outbox', 'e1'),
      await tx.get('sessions', 'seen'),
    ]);
    expect(after.map((d) => [d?.revision, d?.value])).toEqual([
      [2, { status: 'running' }],
      [1, { published: 0, aggregateId: 't1' }],
      [2, { n: 1 }],
    ]);
    // The task and outbox rows got consecutive final seqs, the updated document too.
    expect(after[1]!.seq).toBe(after[0]!.seq + 1);
    expect(out.t2.seq).toBe(after[0]!.seq);

    // Reading a collection with buffered writes sends them first.
    const seenInTx = await s.transaction(async (tx) => {
      await tx.insert('tasks', 't2', { status: 'created' });
      return (await tx.find('tasks', { where: { status: 'created' } })).map(
        (d) => d.id,
      );
    });
    expect(seenInTx).toEqual(['t2']);
    await db.close();
  });

  it('a buffered write that loses fails the transaction and leaves nothing behind (FEAT-032.2)', async () => {
    const s = new PostgresStore({ client: new PGlite(), ownsConnection: true });
    await s.transaction((tx) => tx.insert('tasks', 'taken', { status: 'x' }));
    // Inserted ID is taken: discovered when the writes are sent at commit.
    expect(
      await code(
        s.transaction(async (tx) => {
          await tx.insert('outbox', 'e1', { published: 0 });
          await tx.insert('tasks', 'taken', {});
        }),
      ),
    ).toBe('StaleRevision');
    // A row read in the transaction fails fast on a stale revision or a second insert.
    expect(
      await code(
        s.transaction(async (tx) => {
          const t = (await tx.get('tasks', 'taken'))!;
          await tx.update('tasks', 'taken', t.revision + 1, {});
        }),
      ),
    ).toBe('StaleRevision');
    expect(
      await code(
        s.transaction(async (tx) => {
          await tx.get('tasks', 'taken');
          await tx.insert('tasks', 'taken', {});
        }),
      ),
    ).toBe('StaleRevision');
    expect(await s.transaction((tx) => tx.get('outbox', 'e1'))).toBeUndefined();
    await s.close();
  });

  it('uses pooled connections and releases each one', async () => {
    const db = new PGlite();
    const released: unknown[] = [];
    const pool: PgPool = {
      connect: async () => ({
        query: (text, params) => db.query(text, params),
        release: (e) => released.push(e ?? false),
      }),
    };
    const s = new PostgresStore({ pool });
    await s.transaction((tx) => tx.insert('tasks', 't', { tenantId: 'x' }));
    expect(released.length).toBe(2); // migration + transaction
    expect(released.every((r) => r === false)).toBe(true);
    expect(s.durability).toBe('durable-execution');
    expect(
      await code(Promise.resolve().then(() => new PostgresStore({}))),
    ).toBe('InvalidConfiguration');
    await db.close();
  });
});
