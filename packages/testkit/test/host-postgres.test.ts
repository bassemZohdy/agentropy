// FEAT-041.2: the host runs on PostgreSQL when AGENTROPY_PG_URL is set. The `pg` driver is replaced by a pool over
// embedded PGlite, so the suite stays offline; without the URL the SQLite path is taken and the driver is never loaded.
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
      Pool: class {
        constructor(o: { connectionString: string }) {
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
