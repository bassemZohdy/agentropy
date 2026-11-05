// FEAT-027.4: monitoring at scale (M2-01) — many standing tasks, mailbox back-pressure, lease heartbeat and
// compaction. The baseline numbers printed here are recorded in docs/review/2026-11-05-m2-scale-baseline.md.
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { AgentRuntime, createLocalApp } from '../../runtime/src/index.js';
import { alice, harness, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const ops: TrustedPrincipal = { id: 'ops', type: 'service', tenantId: 't-1' };

const monitoringDef = (id: string): AgentDefinition => ({
  id,
  version: '1.0.0',
  displayName: id,
  profile: { id: 'monitoring', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id, version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
});

/** Subscribes to one symbol, records each price in a bounded checkpoint and completes after `count` events. */
const watcher = (count: number): Agent<{ symbol: string }> => ({
  handle: async (inv, ctx) => {
    const cp = (inv.checkpoint ?? {}) as { sub?: string; prices?: number[] };
    const sub =
      cp.sub ??
      (
        await ctx.capabilities.invoke<unknown, { subscription: string }>(
          'event-handling',
          'subscribe',
          { source: 'price', filter: { symbol: inv.input.symbol } },
          { stepKey: 'sub' },
        )
      ).subscription;
    const prices = [...(cp.prices ?? [])];
    if (inv.wakeReason?.kind === 'event')
      prices.push((inv.wakeReason.payload as { price: number }).price);
    if (prices.length >= count)
      return { kind: 'completed', output: { prices } };
    return {
      kind: 'waiting',
      wakeup: { anyOf: [{ kind: 'event', subscription: sub }] },
      checkpoint: { sub, prices: prices.slice(-count) },
    };
  },
});

function app(opts: { mailboxLimit?: number } = {}) {
  const clock = new FakeClock('2026-11-05T00:00:00.000Z');
  const a = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
    runtime: { poolSize: 16 },
    ...opts,
  });
  return { app: a, clock };
}

describe('monitoring at scale (M2-01)', () => {
  it('200 standing tasks over 20 symbols each process 5 events in order (1,200 activations, 1,000 event-driven)', async () => {
    const { app: a } = app();
    a.define(monitoringDef('watcher'), watcher(5));
    const TASKS = 200;
    const SYMBOLS = 20;
    const EVENTS = 5;
    const started = performance.now();
    const handles: { taskId: string; symbol: string }[] = [];
    for (let i = 0; i < TASKS; i++) {
      const inst = await a.createInstance(
        {
          definition: { id: 'watcher', version: '1.0.0' },
          ownerId: alice.id,
          idempotencyKey: `w${i}`,
        },
        alice,
      );
      const symbol = `S${i % SYMBOLS}`;
      const h = await a.delegate(
        {
          target: { instanceId: inst.id },
          input: { symbol },
          idempotencyKey: `t${i}`,
          correlationId: `t${i}`,
        },
        alice,
      );
      handles.push({ taskId: h.taskId, symbol });
    }
    await a.runUntilIdle();
    const setupMs = performance.now() - started;
    const feedStart = performance.now();
    for (let e = 1; e <= EVENTS; e++)
      for (let s = 0; s < SYMBOLS; s++)
        await a.publishEvent({
          eventId: `S${s}-${e}`,
          source: 'price',
          tenantId: alice.tenantId,
          payload: { symbol: `S${s}`, price: 100 + e },
        });
    await a.runUntilIdle(200);
    const feedMs = performance.now() - feedStart;

    for (const h of handles)
      expect(await a.getResult(h.taskId, alice)).toEqual({
        prices: [101, 102, 103, 104, 105],
      });
    const activations = TASKS * (EVENTS + 1);
    console.log(
      `[scale-baseline] tasks=${TASKS} symbols=${SYMBOLS} events=${SYMBOLS * EVENTS} activations=${activations} setupMs=${setupMs.toFixed(0)} feedMs=${feedMs.toFixed(0)} activationsPerSec=${((TASKS * EVENTS) / (feedMs / 1000)).toFixed(0)}`,
    );

    // Compaction keeps standing state bounded once the work is done.
    const before = await a.store.transaction((tx) =>
      tx.find('mailbox', { where: { consumed: 1 } }),
    );
    expect(before.length).toBe(TASKS * EVENTS);
    const removed = await a.compact(0, ops);
    expect(removed.mailbox).toBe(TASKS * EVENTS);
    expect(removed.inboundEvents).toBe(0); // inside the retention window (same instant)
    expect(
      await a.store.transaction((tx) => tx.find('mailbox', {})),
    ).toHaveLength(0);
  }, 180_000);
});

describe('mailbox back-pressure', () => {
  it('a full mailbox drops further events for that subscription, counts them, and keeps the buffered ones in order', async () => {
    const { app: a } = app({ mailboxLimit: 3 });
    // A watcher that needs 5 events but is suspended, so its mailbox fills up.
    a.define(monitoringDef('slow'), watcher(5));
    const inst = await a.createInstance(
      {
        definition: { id: 'slow', version: '1.0.0' },
        ownerId: alice.id,
        idempotencyKey: 'slow',
      },
      alice,
    );
    const t = await a.delegate(
      {
        target: { instanceId: inst.id },
        input: { symbol: 'X' },
        idempotencyKey: 'slow',
        correlationId: 'slow',
      },
      alice,
    );
    await a.runUntilIdle();
    await a.suspendInstance(inst.id, alice);
    const results = [];
    for (let i = 1; i <= 5; i++)
      results.push(
        await a.wakeups.offer({
          eventId: `x${i}`,
          source: 'price',
          tenantId: alice.tenantId,
          payload: { symbol: 'X', price: i },
        }),
      );
    expect(results.map((r) => [r.appended, r.dropped])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 1],
    ]);
    const [sub] = await a.store.transaction((tx) =>
      tx.find<{ dropped?: number; lastDroppedEventId?: string }>(
        'subscriptions',
        {},
      ),
    );
    expect(sub!.value).toMatchObject({ dropped: 2, lastDroppedEventId: 'x5' });
    // Duplicate delivery of an already recorded event is not even offered to the mailbox.
    expect(
      await a.wakeups.offer({
        eventId: 'x1',
        source: 'price',
        tenantId: alice.tenantId,
        payload: { symbol: 'X', price: 1 },
      }),
    ).toEqual({ accepted: false, appended: 0, dropped: 0 });
    await a.resumeInstance(inst.id, alice);
    await a.runUntilIdle();
    expect((await a.getTask(t.taskId, alice)).status).toBe('waiting');
    for (let i = 6; i <= 7; i++)
      await a.publishEvent({
        eventId: `x${i}`,
        source: 'price',
        tenantId: alice.tenantId,
        payload: { symbol: 'X', price: i },
      });
    await a.runUntilIdle();
    expect(await a.getResult(t.taskId, alice)).toEqual({
      prices: [1, 2, 3, 6, 7],
    });
  });
});

describe('lease heartbeat across workers', () => {
  it('a long-running execution keeps its lease, so a second worker does not recover it as lost', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    h.define('long', {
      handle: async () => {
        runs++;
        await gate;
        return { kind: 'completed', output: 'ok' };
      },
    });
    const t = await h.delegate((await h.instance('long')).id, {}, 'k');
    await h.runtime.tick();
    const other = new AgentRuntime({
      tasks: h.tasks,
      implementations: h.implementations,
      capabilityProviders: new Map([[h.cap.id, h.cap]]),
      leaseMs: 1_000,
    });
    for (let i = 0; i < 5; i++) {
      h.clock.advanceBy(600); // less than the 1 s lease between heartbeats
      await h.runtime.renewLeases();
      expect(await other.recoverExpiredLeases()).toBe(0);
    }
    release();
    await h.runtime.idle();
    await h.runtime.runUntilIdle();
    expect(runs).toBe(1);
    expect(await h.tasks.getResult(t.taskId, alice)).toBe('ok');

    // Without heartbeats the same situation is recovered as a lost lease (control case).
    const h2 = harness();
    h2.define('stuck', { handle: () => new Promise(() => {}) });
    await h2.delegate((await h2.instance('stuck')).id, {}, 'k');
    await h2.runtime.tick();
    const other2 = new AgentRuntime({
      tasks: h2.tasks,
      implementations: h2.implementations,
      capabilityProviders: new Map([[h2.cap.id, h2.cap]]),
    });
    h2.clock.advanceBy(1_500);
    expect(await other2.recoverExpiredLeases()).toBe(1);
  });
});
