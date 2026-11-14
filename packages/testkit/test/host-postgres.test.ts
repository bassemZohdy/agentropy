// FEAT-041.2: the host runs on PostgreSQL when AGENTROPY_PG_URL is set. The `pg` driver is replaced by a pool over
// embedded PGlite, so the suite stays offline; without the URL the SQLite path is taken and the driver is never loaded.
import { EventEmitter } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { openStore, type PgModule } from '../../examples/src/host.js';

describe('host store selection (FEAT-041.2)', () => {
  it('uses SQLite without AGENTROPY_PG_URL and never loads the pg driver', async () => {
    const loadPg = vi.fn();
    const { store, workerId } = await openStore(
      { AGENTROPY_DB: ':memory:' },
      loadPg,
    );
    expect(loadPg).not.toHaveBeenCalled();
    expect(workerId).toBeUndefined();
    expect(store.durability).toBe('none'); // :memory: SQLite
    await store.close();
  });

  it('uses PostgreSQL with the URL, takes the pod name as worker ID, and the store works', async () => {
    const db = new PGlite();
    const urls: string[] = [];
    const pg: PgModule = {
      Pool: class extends EventEmitter {
        constructor(o: { connectionString: string }) {
          super();
          urls.push(o.connectionString);
        }
        async connect() {
          return {
            query: (text: string, params?: unknown[]) => db.query(text, params),
            release: () => undefined,
          };
        }
        async end() {
          /* the PGlite instance is closed by the test */
        }
      } as unknown as PgModule['Pool'],
    };
    const { store, workerId } = await openStore(
      {
        AGENTROPY_PG_URL: 'postgres://db.example/agentropy',
        HOSTNAME: 'pod-7',
      },
      async () => pg,
    );
    expect(urls).toEqual(['postgres://db.example/agentropy']);
    expect(workerId).toBe('pod-7');
    expect(store.durability).toBe('durable-execution');
    await store.transaction((tx) =>
      tx.insert('sessions', 's', { tenantId: 't' }),
    );
    expect(
      (await store.transaction((tx) => tx.get('sessions', 's')))?.value,
    ).toEqual({ tenantId: 't' });
    await db.close();
  });
});

// FIX-055: a dropped idle connection must not end the process, and the store's waits are bounded.
describe('host PostgreSQL pool (FIX-055)', () => {
  /** A pool over PGlite that records its options and every statement, and is an event emitter like `pg.Pool`. */
  function fakePg(db: PGlite) {
    const seen: { options: Record<string, unknown>; statements: string[] } = {
      options: {},
      statements: [],
    };
    const pools: EventEmitter[] = [];
    const pg: PgModule = {
      Pool: class extends EventEmitter {
        constructor(o: Record<string, unknown>) {
          super();
          seen.options = o;
          pools.push(this);
        }
        async connect() {
          return {
            query: (text: string, params?: unknown[]) => {
              seen.statements.push(text);
              return db.query(text, params);
            },
            release: () => undefined,
          };
        }
        async end() {
          /* the PGlite instance is closed by the test */
        }
      } as unknown as PgModule['Pool'],
    };
    return { pg, seen, pool: () => pools[0]! };
  }
  const env = { AGENTROPY_PG_URL: 'postgres://db.example/agentropy' };

  it('FIX-055: a pool error event is logged as one JSON line and the next transaction succeeds', async () => {
    const db = new PGlite();
    const { pg, pool } = fakePg(db);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { store } = await openStore(env, async () => pg);
      const dropped = Object.assign(
        new Error('terminating connection due to administrator command'),
        { code: '57P01' },
      );
      expect(() => pool().emit('error', dropped)).not.toThrow();
      expect(log).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<
        string,
        unknown
      >;
      expect(line).toMatchObject({
        level: 'error',
        event: 'pg.pool.error',
        code: '57P01',
      });
      expect(JSON.stringify(line)).not.toContain('administrator');
      await store.transaction((tx) =>
        tx.insert('sessions', 's', { tenantId: 't' }),
      );
      expect(
        (await store.transaction((tx) => tx.get('sessions', 's')))?.value,
      ).toEqual({ tenantId: 't' });
    } finally {
      log.mockRestore();
      await db.close();
    }
  });

  it('FIX-055: the pool gets a connection timeout and every transaction a statement and a lock timeout', async () => {
    const db = new PGlite();
    const { pg, seen } = fakePg(db);
    const { store } = await openStore(env, async () => pg);
    expect(seen.options).toMatchObject({
      connectionString: env.AGENTROPY_PG_URL,
      connectionTimeoutMillis: 10_000,
    });
    await store.transaction((tx) => tx.insert('sessions', 's', {}));
    // PGlite takes one statement per query, so the settings follow BEGIN as separate statements.
    const sql = seen.statements.join(';');
    expect(sql).toContain('SET LOCAL statement_timeout = 30000');
    expect(sql).toContain('SET LOCAL lock_timeout = 10000');
    await db.close();
  });

  it('FIX-055: the timeouts come from the environment and a bad value is InvalidConfiguration', async () => {
    const db = new PGlite();
    const { pg, seen } = fakePg(db);
    const { store } = await openStore(
      {
        ...env,
        AGENTROPY_PG_CONNECT_TIMEOUT_MS: '2500',
        AGENTROPY_PG_STATEMENT_TIMEOUT_MS: '4000',
        AGENTROPY_PG_LOCK_TIMEOUT_MS: '1500',
      },
      async () => pg,
    );
    expect(seen.options.connectionTimeoutMillis).toBe(2500);
    await store.transaction((tx) => tx.insert('sessions', 's', {}));
    const sql = seen.statements.join(';');
    expect(sql).toContain('SET LOCAL statement_timeout = 4000');
    expect(sql).toContain('SET LOCAL lock_timeout = 1500');
    await db.close();
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      await expect(
        openStore(
          { ...env, AGENTROPY_PG_STATEMENT_TIMEOUT_MS: bad },
          async () => pg,
        ),
      ).rejects.toMatchObject({ code: 'InvalidConfiguration' });
    }
  });
});
