// FEAT-039.3: the scheduler's per-tick reads cost what is due, not what is open or waiting.
import type { CollectionName, Store, StoreTx } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { harness, sqliteTempStore } from './harness.js';

/** Counts the documents each `find` returns, per collection. */
function countingStore() {
  const inner = sqliteTempStore();
  const read: Partial<Record<CollectionName, number>> = {};
  const store: Store = {
    durability: inner.durability,
    close: () => inner.close(),
    transaction: (fn) =>
      inner.transaction((tx) =>
        fn({
          ...tx,
          find: async (c, o) => {
            const rows = await tx.find(c, o);
            read[c] = (read[c] ?? 0) + rows.length;
            return rows;
          },
          get: (c, id) => tx.get(c, id),
          insert: (c, id, v) => tx.insert(c, id, v),
          update: (c, id, r, v) => tx.update(c, id, r, v),
          remove: (c, id, r) => tx.remove(c, id, r),
        } as StoreTx),
      ),
  };
  return { store, read };
}

describe('scheduler reads (FEAT-039.3)', () => {
  it('the human-action sweep reads only lapsed requests, however many are open', async () => {
    const { store, read } = countingStore();
    const h = harness({ store });
    await store.transaction(async (tx) => {
      for (let i = 0; i < 30; i++)
        await tx.insert('humanActions', `open-${i}`, {
          taskId: `t-${i}`,
          status: 'pending',
          dueAt: '2027-01-01T00:00:00.000Z', // not due
        });
      await tx.insert('humanActions', 'no-deadline', {
        taskId: 't-x',
        status: 'pending',
      });
    });
    read.humanActions = 0;
    expect(await h.human.sweep()).toBe(0);
    expect(read.humanActions ?? 0).toBe(0);
  });

  it('a tick reads the executions that are due, not the queue of retries still waiting out their backoff', async () => {
    const { store, read } = countingStore();
    const h = harness({ store });
    await store.transaction(async (tx) => {
      for (let i = 0; i < 30; i++)
        await tx.insert('executions', `later-${i}`, {
          executionId: `later-${i}`,
          taskId: `t-${i}`,
          state: 'queued',
          runAt: '2027-01-01T00:00:00.000Z',
        });
    });
    read.executions = 0;
    expect(await h.runtime.tick()).toBe(0);
    expect(read.executions ?? 0).toBe(0);
  });
});
