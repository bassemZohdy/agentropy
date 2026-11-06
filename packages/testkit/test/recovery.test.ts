// FEAT-022.3: restart and history acceptance — AC-05 (restart while J1 waits), AC-13 (durability none),
// AC-20 (a monitoring task over 150 events keeps a bounded checkpoint and pruned execution history).
import {
  AgentropyError,
  BUILTIN_PROFILES,
  type Agent,
  type InboxEntry,
  type Store,
} from '@agentropy/core';
import { createLocalApp } from '../../runtime/src/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakePolicy } from '../src/index.js';
import {
  MemoryStore,
  SqliteStore,
  alice,
  code,
  completes,
  harness,
} from '../../runtime/test/harness.js';

type H = ReturnType<typeof harness>;

const settle = async (h: H) => {
  for (let i = 0; i < 4; i++) {
    await h.wakeups.poll();
    await h.runtime.runUntilIdle();
  }
};
const tempPath = (tag: string) =>
  join(mkdtempSync(join(tmpdir(), `agentropy-${tag}-`)), 'store.db');

/** J1 monitoring handler: subscribe once, wait for prices, notify and complete below the threshold. */
const monitor: Agent<{ symbol: string; below: number }> = {
  handle: async (inv, ctx) => {
    let sub = (inv.checkpoint as { sub?: string } | undefined)?.sub;
    sub ??= (
      await ctx.capabilities.invoke<unknown, { subscription: string }>(
        'event-handling',
        'subscribe',
        { source: 'price', filter: { symbol: inv.input.symbol } },
        { stepKey: 'sub' },
      )
    ).subscription;
    const r = inv.wakeReason;
    const price =
      r?.kind === 'event' ? (r.payload as { price: number }).price : undefined;
    if (price !== undefined && price < inv.input.below) {
      await ctx.capabilities.invoke(
        'notification',
        'notify',
        {
          severity: 'high',
          title: `ACME is at ${price} (below ${inv.input.below})`,
          body: 'Price alert',
        },
        { stepKey: `crossed:${inv.input.below}` },
      );
      return { kind: 'completed', output: { price } };
    }
    return {
      kind: 'waiting',
      wakeup: { anyOf: [{ kind: 'event', subscription: sub }] },
      checkpoint: { sub },
    };
  },
};

const defineMonitor = (h: H) =>
  h.define('monitor', monitor, {
    profile: { id: 'monitoring', version: '1.0.0' },
  });

const price = (h: H, eventId: string, p: number) =>
  h.wakeups.publish({
    eventId,
    source: 'price',
    tenantId: 't-1',
    payload: { symbol: 'ACME', price: p },
  });

describe('AC-05: kill and restart while J1 is waiting', () => {
  it('the next event after restart still wakes the task, and a duplicate inbound event ID is appended once', async () => {
    const path = tempPath('ac05');
    const before = harness({ builtin: true, store: new SqliteStore({ path }) });
    defineMonitor(before);
    const t = await before.delegate(
      (await before.instance('monitor')).id,
      { symbol: 'ACME', below: 100 },
      'watch',
    );
    await settle(before);
    await price(before, 'p-120', 120);
    await settle(before);
    expect((await before.tasks.getTask(t.taskId, alice)).status).toBe(
      'waiting',
    );
    await (before.store as SqliteStore).close();

    // New process: handlers come from code, all state from the database file.
    const after = harness({ builtin: true, store: new SqliteStore({ path }) });
    defineMonitor(after);
    expect(await price(after, 'p-99', 99)).toBe(true);
    expect(await price(after, 'p-99', 99)).toBe(false);
    await settle(after);
    expect(await after.tasks.getResult(t.taskId, alice)).toEqual({ price: 99 });
    const mailbox = await after.store.transaction((tx) =>
      tx.find<{ eventId: string }>('mailbox', { where: { taskId: t.taskId } }),
    );
    expect(mailbox.map((m) => m.value.eventId).sort()).toEqual([
      'p-120',
      'p-99',
    ]);
    const entries: InboxEntry[] = (await after.inbox.list({}, alice)).entries;
    expect(entries.map((e) => e.title)).toEqual(['ACME is at 99 (below 100)']);
  });
});

describe('AC-13: runtime with durability "none"', () => {
  it('rejects a durable-execution definition with GuaranteeUnavailable; a specialist task is accepted as "none" and is gone after restart', async () => {
    const h = harness({ store: new MemoryStore() });
    defineMonitor(h);
    h.define('helper', completes(), {
      profile: { id: 'specialist', version: '1.0.0' },
    });
    expect(
      await code(
        h.delegate(
          (await h.instance('monitor')).id,
          { symbol: 'ACME', below: 100 },
          'm',
        ),
      ),
    ).toBe('GuaranteeUnavailable');
    const handle = await h.delegate((await h.instance('helper')).id, {}, 's');
    expect(handle.durability).toBe('none');

    const restarted = harness({ store: new MemoryStore() });
    expect(await code(restarted.tasks.getTask(handle.taskId, alice))).toBe(
      'NotFound',
    );
  });
});

describe('AC-20: a monitoring task cycles through 150 events', () => {
  /** Keeps only a running count and the last price: the checkpoint does not grow with history. */
  const counter: Agent = {
    handle: async (inv, ctx) => {
      const cp = (inv.checkpoint ?? {}) as { sub?: string; seen?: number };
      const sub =
        cp.sub ??
        (
          await ctx.capabilities.invoke<unknown, { subscription: string }>(
            'event-handling',
            'subscribe',
            { source: 'tick' },
            { stepKey: 'sub' },
          )
        ).subscription;
      const seen = (cp.seen ?? 0) + (inv.wakeReason?.kind === 'event' ? 1 : 0);
      if (seen >= 150) return { kind: 'completed', output: { seen } };
      return {
        kind: 'waiting',
        wakeup: { anyOf: [{ kind: 'event', subscription: sub }] },
        checkpoint: { sub, seen },
      };
    },
  };

  it('stays under the checkpoint limit and keeps only the last N execution records', async () => {
    const h = harness({
      builtin: true,
      runtime: { maxCheckpointBytes: 256, keepExecutions: 10 },
    });
    h.define('counter', counter, {
      profile: { id: 'monitoring', version: '1.0.0' },
    });
    const t = await h.delegate((await h.instance('counter')).id, {}, 'c');
    await settle(h);
    let maxCheckpoint = 0;
    for (let i = 1; i <= 150; i++) {
      await h.wakeups.publish({
        eventId: `tick-${i}`,
        source: 'tick',
        tenantId: 't-1',
        payload: { i },
      });
      await h.runtime.runUntilIdle();
      const cp = await h.store.transaction((tx) =>
        tx.get<{ data: unknown }>('checkpoints', t.taskId),
      );
      maxCheckpoint = Math.max(
        maxCheckpoint,
        Buffer.byteLength(JSON.stringify(cp?.value.data ?? null)),
      );
      const execs = await h.store.transaction((tx) =>
        tx.find('executions', { where: { taskId: t.taskId } }),
      );
      expect(execs.length).toBeLessThanOrEqual(10);
    }
    expect(await h.tasks.getResult(t.taskId, alice)).toEqual({ seen: 150 });
    expect(maxCheckpoint).toBeLessThan(256);
    const execs = await h.store.transaction((tx) =>
      tx.find<{ activation: number }>('executions', {
        where: { taskId: t.taskId },
      }),
    );
    expect(execs).toHaveLength(10);
    expect(Math.min(...execs.map((e) => e.value.activation))).toBe(142);
  }, 60_000);

  it('a checkpoint over the limit fails the task with SchemaViolation instead of growing without bound', async () => {
    const h = harness({ runtime: { maxCheckpointBytes: 256 } });
    h.define('hoarder', {
      handle: async () => ({
        kind: 'waiting',
        wakeup: { anyOf: [{ kind: 'timer', at: '2026-11-06T00:00:00.000Z' }] },
        checkpoint: { history: 'x'.repeat(300) },
      }),
    });
    const t = await h.delegate((await h.instance('hoarder')).id, {}, 'h');
    await h.runtime.runUntilIdle();
    const snap = await h.tasks.getTask(t.taskId, alice);
    expect([snap.status, snap.outcome?.code]).toEqual([
      'failed',
      'SchemaViolation',
    ]);
  });
});

describe('FEAT-037.1: the scheduler loop survives a failing store', () => {
  it('counts and reports failed ticks, keeps looping, recovers when the store does, and stop() does not reject', async () => {
    const inner = new SqliteStore({ path: ':memory:' });
    let broken = true;
    const store: Store = {
      durability: inner.durability,
      close: () => inner.close(),
      transaction: (fn) =>
        broken
          ? Promise.reject(new AgentropyError('ProviderUnavailable', 'down'))
          : inner.transaction(fn),
    };
    const app = createLocalApp({
      store,
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
    });
    const errors: string[] = [];
    const stop = app.start(5, { onError: (e) => errors.push(e.code) });
    await vi.waitFor(() =>
      expect(app.schedulerStatus().consecutiveFailures).toBeGreaterThanOrEqual(
        3,
      ),
    );
    expect(app.schedulerStatus()).toMatchObject({
      running: true,
      lastError: 'ProviderUnavailable',
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
    broken = false;
    await vi.waitFor(() =>
      expect(app.schedulerStatus().consecutiveFailures).toBe(0),
    );
    expect(app.schedulerStatus().lastTickAt).toBeDefined();
    expect(app.schedulerStatus().lastError).toBeUndefined();
    broken = true; // a failure while stopping must not reject either
    await expect(stop()).resolves.toBeUndefined();
    expect(app.schedulerStatus().running).toBe(false);
  });
});
