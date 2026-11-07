/** Reusable Store conformance suite (ADR-0017): every adapter (memory, SQLite, later PostgreSQL) must pass it. */
import { isAgentropyError, type Store } from '@agentropy/core';
import type { TestApi } from './communication.js';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no-error';
  } catch (err) {
    return isAgentropyError(err) ? err.code : 'non-agentropy';
  }
}

export interface StoreConformanceOptions {
  create: () => Promise<Store>;
  /** For durable adapters: close and reopen the same underlying storage. */
  reopen?: (store: Store) => Promise<Store>;
}

export function defineStoreConformance(
  t: TestApi,
  name: string,
  o: StoreConformanceOptions,
): void {
  t.describe(`store conformance: ${name}`, () => {
    t.it('insert/get and duplicate IDs fail StaleRevision', async () => {
      const s = await o.create();
      const doc = await s.transaction((tx) =>
        tx.insert('tasks', 't1', { tenantId: 'a', status: 'created' }),
      );
      t.expect([doc.revision, doc.value]).toEqual([
        1,
        { tenantId: 'a', status: 'created' },
      ]);
      t.expect(
        await code(
          s.transaction((tx) => tx.insert('tasks', 't1', { tenantId: 'a' })),
        ),
      ).toBe('StaleRevision');
      t.expect(
        (await s.transaction((tx) => tx.get('tasks', 't1')))?.value,
      ).toEqual({ tenantId: 'a', status: 'created' });
      t.expect(await s.transaction((tx) => tx.get('tasks', 'nope'))).toBe(
        undefined,
      );
      await s.close();
    });

    t.it(
      'update and remove are compare-and-swap on revision; seq is stable',
      async () => {
        const s = await o.create();
        const a = await s.transaction((tx) =>
          tx.insert('tasks', 't1', { status: 'created' }),
        );
        const b = await s.transaction((tx) =>
          tx.update('tasks', 't1', 1, { status: 'assigned' }),
        );
        t.expect([b.revision, b.seq]).toEqual([2, a.seq]);
        t.expect(
          await code(
            s.transaction((tx) =>
              tx.update('tasks', 't1', 1, { status: 'running' }),
            ),
          ),
        ).toBe('StaleRevision');
        t.expect(
          await code(
            s.transaction((tx) => tx.update('tasks', 'missing', 1, {})),
          ),
        ).toBe('StaleRevision');
        t.expect(
          await code(s.transaction((tx) => tx.remove('tasks', 't1', 1))),
        ).toBe('StaleRevision');
        await s.transaction((tx) => tx.remove('tasks', 't1', 2));
        t.expect(await s.transaction((tx) => tx.get('tasks', 't1'))).toBe(
          undefined,
        );
        await s.close();
      },
    );

    t.it(
      'find filters by indexed equality and range, orders by seq or field, pages by seq',
      async () => {
        const s = await o.create();
        await s.transaction(async (tx) => {
          await tx.insert('wakeups', 'w3', {
            taskId: 'x',
            status: 'armed',
            dueAt: '2026-11-05T03:00:00Z',
          });
          await tx.insert('wakeups', 'w1', {
            taskId: 'x',
            status: 'armed',
            dueAt: '2026-11-05T01:00:00Z',
          });
          await tx.insert('wakeups', 'w2', {
            taskId: 'y',
            status: 'fired',
            dueAt: '2026-11-05T02:00:00Z',
          });
          await tx.insert('wakeups', 'w4', { taskId: 'y', status: 'armed' });
        });
        const ids = async (p: Promise<{ id: string }[]>) =>
          (await p).map((d) => d.id);
        t.expect(
          await ids(
            s.transaction((tx) =>
              tx.find('wakeups', { where: { status: 'armed' } }),
            ),
          ),
        ).toEqual(['w3', 'w1', 'w4']);
        t.expect(
          await ids(
            s.transaction((tx) =>
              tx.find('wakeups', {
                where: { status: 'armed' },
                range: { field: 'dueAt', lte: '2026-11-05T02:30:00Z' },
              }),
            ),
          ),
        ).toEqual(['w1']);
        t.expect(
          await ids(
            s.transaction((tx) =>
              tx.find('wakeups', {
                where: { status: 'armed' },
                orderBy: 'dueAt',
                limit: 2,
              }),
            ),
          ),
        ).toEqual(['w4', 'w1']);
        const first = (await s.transaction((tx) => tx.find('wakeups', {})))[0]!;
        t.expect(
          await ids(
            s.transaction((tx) =>
              tx.find('wakeups', { afterSeq: first.seq, limit: 1 }),
            ),
          ),
        ).toEqual(['w1']);
        t.expect(
          await ids(
            s.transaction((tx) =>
              tx.find('wakeups', { where: { dueAt: null } }),
            ),
          ),
        ).toEqual(['w4']);
        await s.close();
      },
    );

    t.it(
      'limit 0 returns nothing; strings order by code unit, nulls first; ranges combine with equality',
      async () => {
        const s = await o.create();
        await s.transaction(async (tx) => {
          for (const [id, dueAt] of [
            ['w-e', 'é'],
            ['w-z', 'Z'],
            ['w-a', 'a'],
            ['w-b', 'b'],
          ] as const)
            await tx.insert('wakeups', id, {
              taskId: 'x',
              status: 'armed',
              dueAt,
            });
          await tx.insert('wakeups', 'w-fired', {
            taskId: 'x',
            status: 'fired',
            dueAt: 'a',
          });
          await tx.insert('wakeups', 'w-null', {
            taskId: 'x',
            status: 'armed',
          });
        });
        const ids = async (p: Promise<{ id: string }[]>) =>
          (await p).map((d) => d.id);
        t.expect(
          await ids(s.transaction((tx) => tx.find('wakeups', { limit: 0 }))),
        ).toEqual([]);
        // Code-unit order (uppercase before lowercase, accented after ASCII), nulls first.
        t.expect(
          await ids(
            s.transaction((tx) =>
              tx.find('wakeups', {
                where: { status: 'armed' },
                orderBy: 'dueAt',
              }),
            ),
          ),
        ).toEqual(['w-null', 'w-z', 'w-a', 'w-b', 'w-e']);
        t.expect(
          await ids(
            s.transaction((tx) =>
              tx.find('wakeups', {
                where: { status: 'armed' },
                range: { field: 'dueAt', gte: 'a', lte: 'b' },
                orderBy: 'dueAt',
              }),
            ),
          ),
        ).toEqual(['w-a', 'w-b']);
        await s.close();
      },
    );

    t.it(
      'a failed transaction rolls back every write across collections',
      async () => {
        const s = await o.create();
        await s.transaction((tx) =>
          tx.insert('tasks', 't1', { status: 'running' }),
        );
        const result = await code(
          s.transaction(async (tx) => {
            await tx.update('tasks', 't1', 1, { status: 'waiting' });
            await tx.insert('checkpoints', 'c1', { taskId: 't1', data: 1 });
            await tx.insert('wakeups', 'w1', { taskId: 't1', status: 'armed' });
            await tx.insert('tasks', 't1', {}); // duplicate → StaleRevision → rollback
          }),
        );
        t.expect(result).toBe('StaleRevision');
        const after = await s.transaction(async (tx) => [
          await tx.get('tasks', 't1'),
          await tx.get('checkpoints', 'c1'),
          await tx.get('wakeups', 'w1'),
        ]);
        t.expect([
          after[0]?.revision,
          after[0]?.value,
          after[1],
          after[2],
        ]).toEqual([1, { status: 'running' }, undefined, undefined]);
        await s.close();
      },
    );

    t.it(
      'transactions are serialized: concurrent read-modify-write loses no update',
      async () => {
        const s = await o.create();
        await s.transaction((tx) => tx.insert('sessions', 'counter', { n: 0 }));
        await Promise.all(
          Array.from({ length: 20 }, () =>
            s.transaction(async (tx) => {
              const cur = (await tx.get<{ n: number }>('sessions', 'counter'))!;
              await new Promise((r) => setTimeout(r, 1));
              await tx.update('sessions', 'counter', cur.revision, {
                n: cur.value.n + 1,
              });
            }),
          ),
        );
        t.expect(
          (
            await s.transaction((tx) =>
              tx.get<{ n: number }>('sessions', 'counter'),
            )
          )?.value.n,
        ).toBe(20);
        await s.close();
      },
    );

    t.it('non-scalar indexed fields are rejected', async () => {
      const s = await o.create();
      t.expect(
        await code(
          s.transaction((tx) =>
            tx.insert('tasks', 'bad', { status: { nested: true } }),
          ),
        ),
      ).toBe('Internal');
      await s.close();
    });

    if (o.reopen) {
      const reopen = o.reopen;
      t.it(
        'committed data survives close/reopen; uncommitted data does not; seq keeps increasing',
        async () => {
          const s = await o.create();
          const a = await s.transaction((tx) =>
            tx.insert('outbox', 'e1', { published: 0, aggregateId: 't1' }),
          );
          await code(
            s.transaction(async (tx) => {
              await tx.insert('outbox', 'e2', { published: 0 });
              throw new Error('crash before commit');
            }),
          );
          const s2 = await reopen(s);
          t.expect(
            (await s2.transaction((tx) => tx.find('outbox', {}))).map(
              (d) => d.id,
            ),
          ).toEqual(['e1']);
          const b = await s2.transaction((tx) =>
            tx.insert('outbox', 'e3', { published: 0 }),
          );
          t.expect(b.seq > a.seq).toBe(true);
          await s2.close();
        },
      );
    }
  });
}
