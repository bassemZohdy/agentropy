// FEAT-039.3: the scheduler's per-tick reads cost what is due, not what is open or waiting.
import type { CollectionName, Store, StoreTx } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { alice, bob, completes, harness, sqliteTempStore } from './harness.js';

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

  it('FIX-058: the human-action sweep does not read the resolved requests whose deadline has passed', async () => {
    const { store, read } = countingStore();
    const h = harness({ store });
    const past = '2020-01-01T00:00:00.000Z';
    await store.transaction(async (tx) => {
      for (const [i, status] of (
        ['resolved', 'expired', 'cancelled'] as const
      ).entries())
        for (let n = 0; n < 15; n++)
          await tx.insert('humanActions', `done-${i}-${n}`, {
            taskId: `t-${i}-${n}`,
            status,
            dueAt: past,
            claimExpiresAt: past,
          });
      await tx.insert('humanActions', 'open-due', {
        taskId: 't-open',
        requestId: 'open-due',
        status: 'pending',
        dueAt: past,
      });
      await tx.insert('humanActions', 'open-claim', {
        taskId: 't-claim',
        requestId: 'open-claim',
        status: 'claimed',
        claimedBy: 'alice',
        claimExpiresAt: past,
      });
    });
    read.humanActions = 0;
    expect(await h.human.sweep()).toBe(2);
    expect(read.humanActions ?? 0).toBe(2);
    const status = async (id: string) =>
      (await store.transaction((tx) =>
        tx.get<{ status: string }>('humanActions', id),
      ))!.value.status;
    expect(await status('open-due')).toBe('expired');
    expect(await status('open-claim')).toBe('pending');
    // The next sweep finds nothing left to do and reads nothing.
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

describe('listings and quotas read through indexes (FEAT-039.3)', () => {
  it('listTasks pages through the caller’s tasks with a status filter, and a user with none reads nothing', async () => {
    const { store, read } = countingStore();
    const h = harness({ store });
    h.define('d', completes());
    const inst = await h.instance('d');
    for (let i = 0; i < 3; i++) await h.delegate(inst.id, {}, `done-${i}`);
    await h.runtime.runUntilIdle(); // these three complete
    for (let i = 0; i < 4; i++) await h.delegate(inst.id, {}, `queued-${i}`); // these stay assigned

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await h.tasks.listTasks(
        { status: ['completed'], limit: 2, ...(cursor ? { cursor } : {}) },
        alice,
      );
      seen.push(...r.tasks.map((t) => t.taskId));
      if (r.tasks.length < 2) break;
      cursor = r.cursor;
    }
    expect(new Set(seen).size).toBe(3);
    const all = await h.tasks.listTasks({ limit: 200 }, alice);
    expect(all.tasks).toHaveLength(7);

    read.tasks = 0;
    expect((await h.tasks.listTasks({}, bob)).tasks).toEqual([]);
    expect(read.tasks ?? 0).toBe(0); // bob has no tasks: the index answers without reading the tenant's seven
  });

  it('task quotas count live tasks and the last minute through the indexes', async () => {
    const h = harness();
    h.define('d', completes());
    const inst = await h.instance('d');
    // maxActiveTasks 2: the third live task is refused; finished tasks do not count.
    const { checkTaskQuota } = await import('../src/quotas.js');
    await h.delegate(inst.id, {}, 'a');
    await h.delegate(inst.id, {}, 'b');
    const refuse = (quota: {
      maxActiveTasks?: number;
      maxAcceptsPerMinute?: number;
    }) =>
      h.store
        .transaction((tx) => checkTaskQuota(tx, 't-1', quota, h.clock.iso()))
        .then(
          () => 'ok',
          (e: { code: string }) => e.code,
        );
    expect(await refuse({ maxActiveTasks: 2 })).toBe('QuotaExceeded');
    expect(await refuse({ maxActiveTasks: 3 })).toBe('ok');
    expect(await refuse({ maxAcceptsPerMinute: 2 })).toBe('QuotaExceeded');
    h.clock.advanceBy(61_000); // the two accepts fall out of the minute
    expect(await refuse({ maxAcceptsPerMinute: 2 })).toBe('ok');
    await h.runtime.runUntilIdle(); // both finish
    expect(await refuse({ maxActiveTasks: 1 })).toBe('ok');
  });
});

describe('inbox briefing reads (FEAT-039.3)', () => {
  it('a briefing reads only entries it may show: after they are presented a repeat reads none', async () => {
    const { store, read } = countingStore();
    const h = harness({ store, builtin: true });
    h.define('n', {
      handle: async (_inv, ctx) => {
        for (const k of ['a', 'b', 'c'])
          await ctx.capabilities.invoke(
            'notification',
            'notify',
            { severity: 'high', title: `t-${k}`, body: 'b', dedupeKey: k },
            { stepKey: k },
          );
        return { kind: 'completed', output: null };
      },
    });
    await h.delegate((await h.instance('n')).id, {}, 'k');
    await h.runtime.runUntilIdle();

    const first = await h.inbox.briefing(alice);
    expect(first.entries.map((e) => e.title).sort()).toEqual([
      't-a',
      't-b',
      't-c',
    ]);
    read.inbox = 0;
    const again = await h.inbox.briefing(alice);
    expect(again.entries).toEqual([]);
    expect(read.inbox ?? 0).toBe(0); // presented entries are no longer candidates

    // Acknowledged entries stay out too; a revised entry (new revision) is a candidate again.
    const [entry] = (await h.inbox.list({}, alice)).entries;
    await h.inbox.mark(entry!.entryId, 'acknowledged', alice);
    expect((await h.inbox.briefing(alice)).entries).toEqual([]);
  });
});
