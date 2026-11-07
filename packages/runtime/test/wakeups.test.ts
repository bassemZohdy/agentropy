// Wake-ups (FEAT-018): timers, schedules, timeouts, durable event subscriptions with mailboxes,
// child-task waits (AC-12), suspended-instance deferral and restart while waiting.
import {
  InstanceDirectory,
  AgentRuntime,
  TaskService,
  WakeupService,
  BuiltinCapabilityProvider,
  coreOperationHandlers,
} from '../src/index.js';
import type {
  Agent,
  AgentDisposition,
  Store,
  StoreTx,
  WakeReason,
} from '@agentropy/core';
import { SqliteStore } from '@agentropy/store-sqlite';
import { describe, expect, it, vi } from 'vitest';
import { alice, code, harness, sqliteTempStore } from './harness.js';

const status = async (h: ReturnType<typeof harness>, id: string) =>
  (await h.tasks.getTask(id, alice)).status;
const settle = async (h: ReturnType<typeof harness>) => {
  for (let i = 0; i < 10; i++) {
    await h.wakeups.poll();
    await h.runtime.runUntilIdle();
  }
};

/** A store that counts wake-up reads by ID: one per registration a poll evaluates. */
function countingStore() {
  const inner = sqliteTempStore();
  const seen = { evaluated: 0 };
  const store: Store = {
    durability: inner.durability,
    close: () => inner.close(),
    transaction: (fn) =>
      inner.transaction((tx) =>
        fn({
          ...tx,
          get: (c, id) => {
            if (c === 'wakeups') seen.evaluated++;
            return tx.get(c, id);
          },
          find: (c, o) => tx.find(c, o),
          insert: (c, id, v) => tx.insert(c, id, v),
          update: (c, id, r, v) => tx.update(c, id, r, v),
          remove: (c, id, r) => tx.remove(c, id, r),
        } as StoreTx),
      ),
  };
  return { store, seen };
}

describe('wake-up evaluation index (FEAT-033.2)', () => {
  it('a poll evaluates only due or poked registrations; a periodic full scan backs up a missed poke', async () => {
    const { store, seen } = countingStore();
    const h = harness({ builtin: true, store });
    h.define('sleeper', {
      handle: async (inv) =>
        inv.activation === 1
          ? {
              kind: 'waiting',
              wakeup: {
                anyOf: [{ kind: 'timer', at: '2027-01-01T00:00:00.000Z' }],
              },
              checkpoint: null,
            }
          : { kind: 'completed', output: null },
    });
    h.define('listener', {
      handle: async (inv) =>
        inv.activation === 1
          ? {
              kind: 'waiting',
              wakeup: { anyOf: [{ kind: 'event', subscription: 'manual' }] },
              checkpoint: null,
            }
          : { kind: 'completed', output: inv.wakeReason },
    });
    const sleepers = (await h.instance('sleeper')).id;
    for (let i = 0; i < 20; i++) await h.delegate(sleepers, {}, `s${i}`);
    const t = await h.delegate((await h.instance('listener')).id, {}, 'l');
    await settle(h);
    expect(await status(h, t.taskId)).toBe('waiting');

    seen.evaluated = 0;
    await h.wakeups.poll();
    expect(seen.evaluated).toBe(0); // 21 armed registrations, none due or poked

    // A mailbox row written without a poke (as by an older writer) is found by the next full scan only.
    await h.store.transaction((tx) =>
      tx.insert('mailbox', 'manual:e1', {
        taskId: t.taskId,
        subscriptionId: 'manual',
        eventId: 'e1',
        payload: { n: 1 },
        consumed: 0,
      }),
    );
    await settle(h);
    expect(await status(h, t.taskId)).toBe('waiting');
    h.clock.advanceBy(60_000);
    await settle(h);
    expect(await h.tasks.getResult(t.taskId, alice)).toMatchObject({
      kind: 'event',
      eventId: 'e1',
    });
  });
});

describe('timer, schedule and timeout wake-ups', () => {
  it('a timer wakes the task as a new activation with a timer reason (T5)', async () => {
    const h = harness({ builtin: true });
    const reasons: (WakeReason | undefined)[] = [];
    h.define('sleeper', {
      handle: async (inv) => {
        reasons.push(inv.wakeReason);
        return inv.activation === 1
          ? {
              kind: 'waiting',
              wakeup: {
                anyOf: [{ kind: 'timer', at: '2026-11-05T01:00:00.000Z' }],
              },
              checkpoint: { n: 1 },
            }
          : {
              kind: 'completed',
              output: {
                activation: inv.activation,
                checkpoint: inv.checkpoint,
              },
            };
      },
    });
    const t = await h.delegate((await h.instance('sleeper')).id, {}, 'k');
    await settle(h);
    expect(await status(h, t.taskId)).toBe('waiting');
    h.clock.advanceBy(60 * 60 * 1000);
    await settle(h);
    expect(await h.tasks.getResult(t.taskId, alice)).toEqual({
      activation: 2,
      checkpoint: { n: 1 },
    });
    expect(reasons[1]).toEqual({
      kind: 'timer',
      firedAt: '2026-11-05T01:00:00.000Z',
    });
  });

  it('timeout with onTimeout "fail" fails the task (T9); with "resume" it resumes with a timeout reason', async () => {
    const h = harness({ builtin: true });
    const mk = (onTimeout: 'fail' | 'resume'): Agent => ({
      handle: async (inv) =>
        inv.activation === 1
          ? {
              kind: 'waiting',
              wakeup: {
                anyOf: [{ kind: 'event', subscription: 'never' }],
                timeoutAt: '2026-11-05T00:10:00.000Z',
                onTimeout,
              },
              checkpoint: null,
            }
          : { kind: 'completed', output: inv.wakeReason },
    });
    h.define('strict', mk('fail'));
    h.define('lenient', mk('resume'));
    const a = await h.delegate((await h.instance('strict')).id, {}, 'a');
    const b = await h.delegate((await h.instance('lenient')).id, {}, 'b');
    await settle(h);
    h.clock.advanceBy(10 * 60 * 1000);
    await settle(h);
    expect((await h.tasks.getTask(a.taskId, alice)).outcome?.code).toBe(
      'Timeout',
    );
    expect(await h.tasks.getResult(b.taskId, alice)).toEqual({
      kind: 'timeout',
    });
  });

  it('a UTC cron schedule wakes at its next occurrence; other timezones are unsupported', async () => {
    const h = harness({ builtin: true });
    h.define('cron', {
      handle: async (inv) =>
        inv.activation === 1
          ? {
              kind: 'waiting',
              wakeup: {
                anyOf: [
                  { kind: 'schedule', cron: '30 9 * * *', timezone: 'UTC' },
                ],
              },
              checkpoint: null,
            }
          : { kind: 'completed', output: inv.wakeReason },
    });
    h.define('tz', {
      handle: async () => ({
        kind: 'waiting',
        wakeup: {
          anyOf: [
            { kind: 'schedule', cron: '0 9 * * *', timezone: 'Asia/Dubai' },
          ],
        },
        checkpoint: null,
      }),
    });
    const t = await h.delegate((await h.instance('cron')).id, {}, 'k');
    const u = await h.delegate((await h.instance('tz')).id, {}, 'u');
    await settle(h);
    h.clock.advanceBy(9 * 60 * 60 * 1000 + 29 * 60 * 1000);
    await settle(h);
    expect(await status(h, t.taskId)).toBe('waiting');
    h.clock.advanceBy(60 * 1000);
    await settle(h);
    expect(await h.tasks.getResult(t.taskId, alice)).toEqual({
      kind: 'schedule',
      firedAt: '2026-11-05T09:30:00.000Z',
    });
    expect((await h.tasks.getTask(u.taskId, alice)).outcome?.code).toBe(
      'UnsupportedOperation',
    );
  });
});

describe('durable event subscriptions (J1 shape, R-08)', () => {
  const monitor: Agent = {
    handle: async (inv, ctx): Promise<AgentDisposition<unknown>> => {
      const state = (inv.checkpoint as
        { seen: number[]; sub: string } | undefined) ?? { seen: [], sub: '' };
      if (inv.activation === 1) {
        const { subscription } = await ctx.capabilities.invoke<
          unknown,
          { subscription: string }
        >(
          'event-handling',
          'subscribe',
          { source: 'price', filter: { symbol: 'ACME' } },
          { stepKey: 'sub' },
        );
        state.sub = subscription;
      }
      if (inv.wakeReason?.kind === 'event') {
        const price = (inv.wakeReason.payload as { price: number }).price;
        state.seen.push(price);
        if (price < 100) return { kind: 'completed', output: state.seen };
      }
      return {
        kind: 'waiting',
        wakeup: { anyOf: [{ kind: 'event', subscription: state.sub }] },
        checkpoint: state,
      };
    },
  };

  it('back-to-back events are buffered and consumed oldest-first, one activation each; duplicates and other symbols are ignored', async () => {
    const h = harness({ builtin: true });
    h.define('watch', monitor, {
      profile: { id: 'monitoring', version: '1.0.0' },
    });
    const t = await h.delegate(
      (await h.instance('watch')).id,
      { symbol: 'ACME' },
      'k',
    );
    await settle(h);
    expect(await status(h, t.taskId)).toBe('waiting');
    const publish = (eventId: string, price: number, symbol = 'ACME') =>
      h.wakeups.publish({
        eventId,
        source: 'price',
        tenantId: 't-1',
        payload: { symbol, price },
      });
    expect(await publish('e1', 120)).toBe(true);
    expect(await publish('e1', 120)).toBe(false); // same inbound event ID appended once
    await publish('x1', 50, 'OTHER');
    await publish('e2', 105);
    await publish('e3', 99);
    await settle(h);
    expect(await h.tasks.getResult(t.taskId, alice)).toEqual([120, 105, 99]);
    const execs = await h.store.transaction((tx) =>
      tx.find<{ activation: number }>('executions', {
        where: { taskId: t.taskId },
      }),
    );
    expect(execs.map((e) => e.value.activation)).toEqual([1, 2, 3, 4]);
  });

  it('events published while the task is running are delivered on the next activation', async () => {
    const h = harness({ builtin: true });
    let gate!: () => void;
    const blocked = new Promise<void>((r) => (gate = r));
    h.define(
      'watch',
      {
        handle: async (inv, ctx) => {
          if (inv.activation === 1) {
            const { subscription } = await ctx.capabilities.invoke<
              unknown,
              { subscription: string }
            >(
              'event-handling',
              'subscribe',
              { source: 'price' },
              { stepKey: 'sub' },
            );
            await blocked;
            return {
              kind: 'waiting',
              wakeup: { anyOf: [{ kind: 'event', subscription }] },
              checkpoint: null,
            };
          }
          return { kind: 'completed', output: inv.wakeReason };
        },
      },
      { profile: { id: 'monitoring', version: '1.0.0' } },
    );
    const t = await h.delegate((await h.instance('watch')).id, {}, 'k');
    await h.runtime.tick();
    await vi.waitFor(async () =>
      expect(
        await h.store.transaction((tx) => tx.find('subscriptions', {})),
      ).toHaveLength(1),
    );
    await h.wakeups.publish({
      eventId: 'early',
      source: 'price',
      tenantId: 't-1',
      payload: { price: 1 },
    });
    gate();
    await settle(h);
    expect(await h.tasks.getResult(t.taskId, alice)).toMatchObject({
      kind: 'event',
      eventId: 'early',
    });
  });

  it('subscriptions are revoked on terminal transitions', async () => {
    const h = harness({ builtin: true });
    h.define('watch', monitor, {
      profile: { id: 'monitoring', version: '1.0.0' },
    });
    const t = await h.delegate((await h.instance('watch')).id, {}, 'k');
    await settle(h);
    await h.tasks.cancel(t.taskId, alice);
    const subs = await h.store.transaction((tx) =>
      tx.find<{ status: string }>('subscriptions', {
        where: { taskId: t.taskId },
      }),
    );
    expect(subs.map((s) => s.value.status)).toEqual(['revoked']);
  });
});

describe('child-task waits (AC-12, R-05)', () => {
  it('a coordinator waits for all children and resumes once with every terminal outcome', async () => {
    const h = harness({ builtin: true });
    h.define(
      'ok-child',
      { handle: async () => ({ kind: 'completed', output: 'done' }) },
      { profile: { id: 'specialist', version: '1.0.0' } },
    );
    h.define(
      'bad-child',
      {
        handle: async () => ({
          kind: 'failed',
          code: 'BudgetExceeded',
          retryable: false,
          message: 'no',
        }),
      },
      { profile: { id: 'specialist', version: '1.0.0' } },
    );
    const okInst = await h.instance('ok-child');
    const badInst = await h.instance('bad-child');
    let resumes = 0;
    h.define(
      'coordinator',
      {
        handle: async (inv, ctx) => {
          if (inv.activation === 1) {
            const a = await ctx.capabilities.invoke<
              unknown,
              { taskId: string }
            >(
              'delegation',
              'delegate',
              { target: { instanceId: okInst.id }, input: {} },
              { stepKey: 'child:a' },
            );
            const b = await ctx.capabilities.invoke<
              unknown,
              { taskId: string }
            >(
              'delegation',
              'delegate',
              { target: { instanceId: badInst.id }, input: {} },
              { stepKey: 'child:b' },
            );
            return {
              kind: 'waiting',
              wakeup: {
                anyOf: [
                  {
                    kind: 'child-tasks',
                    taskIds: [a.taskId, b.taskId],
                    mode: 'all',
                  },
                ],
              },
              checkpoint: null,
            };
          }
          resumes++;
          return { kind: 'completed', output: inv.wakeReason };
        },
      },
      { profile: { id: 'coordinator', version: '1.0.0' } },
    );
    const t = await h.delegate((await h.instance('coordinator')).id, {}, 'k');
    await settle(h);
    expect(resumes).toBe(1);
    const reason = (
      await h.tasks.getResult<WakeReason & { kind: 'child-tasks' }>(
        t.taskId,
        alice,
      )
    ).children;
    expect(reason.map((c) => [c.status, c.output ?? c.outcome?.code])).toEqual([
      ['completed', 'done'],
      ['failed', 'BudgetExceeded'],
    ]);
  });

  it('a replayed coordinator does not spawn duplicate children (step-key idempotency)', async () => {
    const h = harness({ builtin: true });
    h.define(
      'child',
      { handle: async () => ({ kind: 'completed', output: 1 }) },
      { profile: { id: 'specialist', version: '1.0.0' } },
    );
    const child = await h.instance('child');
    h.define(
      'coord',
      {
        handle: async (inv, ctx) => {
          await ctx.capabilities.invoke(
            'delegation',
            'delegate',
            { target: { instanceId: child.id }, input: {} },
            { stepKey: 'only-child' },
          );
          if (inv.attempt === 1) throw new Error('crash after delegating');
          return { kind: 'completed', output: null };
        },
      },
      { profile: { id: 'coordinator', version: '1.0.0' } },
    );
    const t = await h.delegate((await h.instance('coord')).id, {}, 'k');
    await settle(h);
    h.clock.advanceBy(5_000);
    await settle(h);
    const children = await h.store.transaction((tx) =>
      tx.find('tasks', { where: { parentTaskId: t.taskId } }),
    );
    expect(children).toHaveLength(1);
    expect(await code(h.tasks.getResult(t.taskId, alice))).toBe('no-error');
  });
});

describe('deferral and restart', () => {
  it('wake-ups of a suspended instance are deferred, not dropped', async () => {
    const h = harness({ builtin: true });
    h.define('sleeper', {
      handle: async (inv) =>
        inv.activation === 1
          ? {
              kind: 'waiting',
              wakeup: {
                anyOf: [{ kind: 'timer', at: '2026-11-05T00:01:00.000Z' }],
              },
              checkpoint: null,
            }
          : { kind: 'completed', output: 'woke' },
    });
    const inst = await h.instance('sleeper');
    const t = await h.delegate(inst.id, {}, 'k');
    await settle(h);
    await h.instances.suspend(inst.id, alice);
    h.clock.advanceBy(120_000);
    await settle(h);
    expect(await status(h, t.taskId)).toBe('waiting');
    await h.instances.resume(inst.id, alice);
    await settle(h);
    expect(await h.tasks.getResult(t.taskId, alice)).toBe('woke');
  });

  it('a waiting task survives a full restart and is woken by the next event (AC-05 runtime part)', async () => {
    const store = sqliteTempStore();
    const h = harness({ builtin: true, store });
    const watcher: Agent = {
      handle: async (inv, ctx) => {
        if (inv.activation === 1) {
          const { subscription } = await ctx.capabilities.invoke<
            unknown,
            { subscription: string }
          >(
            'event-handling',
            'subscribe',
            { source: 'price' },
            { stepKey: 'sub' },
          );
          return {
            kind: 'waiting',
            wakeup: { anyOf: [{ kind: 'event', subscription }] },
            checkpoint: { subscription },
          };
        }
        return { kind: 'completed', output: inv.wakeReason };
      },
    };
    h.define('watch', watcher, {
      profile: { id: 'monitoring', version: '1.0.0' },
    });
    const t = await h.delegate((await h.instance('watch')).id, {}, 'k');
    await settle(h);
    const path = (
      store as unknown as { db: { location(): string } }
    ).db.location();
    await store.close();

    // New process: same definitions/handlers loaded from code, state from the database file.
    const h2 = harness({ builtin: true, store: new SqliteStore({ path }) });
    h2.define('watch', watcher, {
      profile: { id: 'monitoring', version: '1.0.0' },
    });
    await h2.wakeups.publish({
      eventId: 'after-restart',
      source: 'price',
      tenantId: 't-1',
      payload: { price: 1 },
    });
    await h2.wakeups.publish({
      eventId: 'after-restart',
      source: 'price',
      tenantId: 't-1',
      payload: { price: 1 },
    });
    await settle(h2);
    expect(await h2.tasks.getResult(t.taskId, alice)).toMatchObject({
      kind: 'event',
      eventId: 'after-restart',
    });
    void [
      InstanceDirectory,
      AgentRuntime,
      TaskService,
      WakeupService,
      BuiltinCapabilityProvider,
      coreOperationHandlers,
    ];
  });
});

describe('deadline and activation budget while waiting (FEAT-038.1)', () => {
  const forever: Agent = {
    handle: async () => ({
      kind: 'waiting',
      wakeup: { anyOf: [{ kind: 'event', subscription: 'never' }] },
      checkpoint: null,
    }),
  };

  it('a waiting task past its deadline fails with Timeout, though nothing woke it', async () => {
    const h = harness({ builtin: true });
    h.define('patient', forever);
    const inst = await h.instance('patient');
    const t = await h.delegate(inst.id, {}, 'd', alice, {
      deadline: '2026-11-05T01:00:00.000Z',
    });
    await settle(h);
    expect(await status(h, t.taskId)).toBe('waiting');
    h.clock.advanceBy(30 * 60_000); // 00:30, before the deadline
    await settle(h);
    expect(await status(h, t.taskId)).toBe('waiting');
    h.clock.advanceBy(31 * 60_000); // 01:01
    await settle(h);
    const snap = await h.tasks.getTask(t.taskId, alice);
    expect([snap.status, snap.outcome?.code]).toEqual(['failed', 'Timeout']);
  });

  it('budget.maxActivations refuses the activation after the last one', async () => {
    const h = harness({ builtin: true });
    h.define('ticker', {
      handle: async () => ({
        kind: 'waiting',
        wakeup: { anyOf: [{ kind: 'timer', at: '2026-11-05T00:00:00.000Z' }] },
        checkpoint: null,
      }),
    });
    const inst = await h.instance('ticker');
    const t = await h.delegate(inst.id, {}, 'b', alice, {
      budget: { maxActivations: 3 },
    });
    await settle(h);
    const snap = await h.tasks.getTask(t.taskId, alice);
    expect([snap.status, snap.outcome?.code]).toEqual([
      'failed',
      'BudgetExceeded',
    ]);
    const executions = await h.store.transaction((tx) =>
      tx.find('executions', { where: { taskId: t.taskId } }),
    );
    expect(executions).toHaveLength(3); // activations 1, 2 and 3 ran
  });
});

describe('re-subscribing (FEAT-038.2)', () => {
  it('subscribe after unsubscribe makes the same subscription active again, so events are delivered', async () => {
    const h = harness({ builtin: true });
    const sub = await h.wakeups.subscribe('task-x', 't-1', 'feed');
    await h.wakeups.unsubscribe(sub, 'task-x');
    expect(await h.wakeups.subscribe('task-x', 't-1', 'feed')).toBe(sub);
    const row = await h.store.transaction((tx) => tx.get('subscriptions', sub));
    expect((row?.value as { status: string }).status).toBe('active');
    await h.wakeups.publish({
      eventId: 'e1',
      source: 'feed',
      tenantId: 't-1',
      payload: {},
    });
    const mail = await h.store.transaction((tx) =>
      tx.find('mailbox', { where: { subscriptionId: sub } }),
    );
    expect(mail).toHaveLength(1);
  });
});

describe('event ingestion cost (FEAT-039.4)', () => {
  it('publishing an event evaluates the poked wake-ups but does not run every sweep again', async () => {
    const h = harness({ builtin: true });
    let sweeps = 0;
    h.wakeups.addSweep(async () => void sweeps++);
    h.define('listener', {
      handle: async (inv) =>
        inv.activation === 1
          ? {
              kind: 'waiting',
              wakeup: { anyOf: [{ kind: 'event', subscription: 'manual' }] },
              checkpoint: null,
            }
          : { kind: 'completed', output: inv.wakeReason },
    });
    await h.wakeups.subscribe('placeholder', 't-1', 'feed'); // an active subscription to deliver to
    await h.delegate((await h.instance('listener')).id, {}, 'l');
    await settle(h);
    sweeps = 0;
    await h.wakeups.publish({
      eventId: 'e-1',
      source: 'feed',
      tenantId: 't-1',
      payload: {},
    });
    expect(sweeps).toBe(0); // the ingestion poll skipped the sweeps
    await h.wakeups.poll();
    expect(sweeps).toBe(1); // the scheduler's own poll still runs them
  });
});
