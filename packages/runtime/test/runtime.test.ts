// Runtime and pool (FEAT-017.2): AC-06 lease loss + fencing, AC-10 version pinning, AC-11 cancel grace,
// retries with backoff, disposition mapping, T4 persistence and the CapabilityAccess surface.
import type { Agent, Store } from '@agentropy/core';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { alice, code, completes, harness, sqliteTempStore } from './harness.js';

const status = async (h: ReturnType<typeof harness>, taskId: string) =>
  (await h.tasks.getTask(taskId, alice)).status;
const executions = async (h: ReturnType<typeof harness>, taskId: string) =>
  (
    await h.store.transaction((tx) =>
      tx.find<{ state: string; attempt: number; activation: number }>(
        'executions',
        { where: { taskId } },
      ),
    )
  ).map((e) => [e.value.state, e.value.activation, e.value.attempt]);

describe('lease loss and fencing (AC-06, R-08)', () => {
  it('a crashed worker’s execution is lost, a new attempt succeeds, and the old epoch cannot write', async () => {
    const h = harness();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    h.define('flaky', {
      handle: async (inv) => {
        if (inv.attempt === 1) await firstGate;
        return { kind: 'completed', output: { attempt: inv.attempt } };
      },
    });
    const t = await h.delegate((await h.instance('flaky')).id, {}, 'k');
    await h.runtime.tick(); // worker 1 leases attempt 1 and "crashes" (never returns in time)
    expect(await status(h, t.taskId)).toBe('running');

    // Restart: a fresh pool over the same store, after the lease expired.
    const restarted = new AgentRuntime({
      tasks: h.tasks,
      implementations: h.implementations,
      capabilityProviders: new Map([[h.cap.id, h.cap]]),
      leaseMs: 1_000,
    });
    h.clock.advanceBy(1_001);
    await restarted.runUntilIdle();
    expect(await h.tasks.getResult(t.taskId, alice)).toEqual({ attempt: 2 });
    expect(await executions(h, t.taskId)).toEqual([
      ['lost', 1, 1],
      ['succeeded', 1, 2],
    ]);

    // The original worker finally returns: its stale-epoch write is rejected and changes nothing.
    releaseFirst();
    await h.runtime.idle();
    expect(await h.tasks.getResult(t.taskId, alice)).toEqual({ attempt: 2 });
    expect((await h.tasks.getTask(t.taskId, alice)).revision).toBe(6); // created, assigned, running, assigned (T6), running, completed
  });
});

describe('version pinning (AC-10 runtime part, R-23)', () => {
  it('a task accepted on v1 runs the v1 handler after v2 registers; a removed v1 handler fails IncompatibleVersion', async () => {
    const h = harness();
    h.define('expense', completes({ version: 1 }));
    const inst = await h.instance('expense');
    const pinned = await h.delegate(inst.id, {}, 'a');
    const orphan = await h.delegate(inst.id, {}, 'b');
    h.define('expense', completes({ version: 2 }), {}, '2.0.0');
    await h.runtime.runUntilIdle();
    expect(await h.tasks.getResult(pinned.taskId, alice)).toEqual({
      version: 1,
    });

    const t3 = await h.delegate(inst.id, {}, 'c');
    h.handlers.unregister({ id: 'expense', version: '1.0.0' });
    await h.runtime.runUntilIdle();
    expect(await status(h, t3.taskId)).toBe('failed');
    expect((await h.tasks.getTask(t3.taskId, alice)).outcome?.code).toBe(
      'IncompatibleVersion',
    );
    void orphan;
  });
});

describe('cancellation (AC-11, R-07)', () => {
  it('a handler that ignores AbortSignal is fenced after the grace period; the late result is discarded', async () => {
    const h = harness({ cancelGraceMs: 20 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.define('stubborn', {
      handle: async () => (await gate, { kind: 'completed', output: 'late' }),
    });
    const t = await h.delegate((await h.instance('stubborn')).id, {}, 'k');
    await h.runtime.tick();
    expect(
      (await h.tasks.cancel(t.taskId, alice)).cancelRequestedAt,
    ).toBeDefined();
    expect(await status(h, t.taskId)).toBe('running');
    await vi.waitFor(async () =>
      expect(await status(h, t.taskId)).toBe('cancelled'),
    );
    expect(await executions(h, t.taskId)).toEqual([['lost', 1, 1]]);
    release();
    await h.runtime.idle();
    expect(await code(h.tasks.getResult(t.taskId, alice))).toBe(
      'TaskCancelled',
    );
  });

  it('a cooperative handler that returns after abort is E7b aborted + T11 cancelled', async () => {
    const h = harness({ cancelGraceMs: 5_000 });
    h.define('polite', {
      handle: (_inv, ctx) =>
        new Promise((resolve) =>
          ctx.signal.addEventListener('abort', () =>
            resolve({ kind: 'completed', output: 'ignored' }),
          ),
        ),
    });
    const t = await h.delegate((await h.instance('polite')).id, {}, 'k');
    await h.runtime.tick();
    await h.tasks.cancel(t.taskId, alice);
    await h.runtime.idle();
    expect(await status(h, t.taskId)).toBe('cancelled');
    expect(await executions(h, t.taskId)).toEqual([['aborted', 1, 1]]);
  });
});

describe('dispositions and retries (runtime contract T4/T6/T7/T8)', () => {
  it('retries a thrown error with backoff in the same activation, then completes', async () => {
    const h = harness();
    h.define('retry', {
      handle: async (inv) =>
        inv.attempt < 3
          ? Promise.reject(new Error('transient'))
          : { kind: 'completed', output: inv.attempt },
    });
    const t = await h.delegate((await h.instance('retry')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    expect(await status(h, t.taskId)).toBe('assigned'); // attempt 2 waits for its backoff
    h.clock.advanceBy(1_000);
    await h.runtime.runUntilIdle();
    h.clock.advanceBy(2_000);
    await h.runtime.runUntilIdle();
    expect(await h.tasks.getResult(t.taskId, alice)).toBe(3);
    expect(await executions(h, t.taskId)).toEqual([
      ['failed', 1, 1],
      ['failed', 1, 2],
      ['succeeded', 1, 3],
    ]);
  });

  it('a non-retryable failed disposition fails the task with its code', async () => {
    const h = harness();
    h.define('fails', {
      handle: async () => ({
        kind: 'failed',
        code: 'BudgetExceeded',
        retryable: false,
        message: 'over budget',
      }),
    });
    const t = await h.delegate((await h.instance('fails')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    expect(await code(h.tasks.getResult(t.taskId, alice))).toBe('TaskFailed');
    expect((await h.tasks.getTask(t.taskId, alice)).outcome).toEqual({
      code: 'BudgetExceeded',
      message: 'over budget',
    });
  });

  it('output that violates outputSchema fails the task (T8)', async () => {
    const h = harness();
    h.define('bad-output', completes({ wrong: true }), {
      outputSchema: { type: 'object', required: ['reply'] },
    });
    const t = await h.delegate((await h.instance('bad-output')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    expect((await h.tasks.getTask(t.taskId, alice)).outcome?.code).toBe(
      'SchemaViolation',
    );
  });

  it('waiting commits the checkpoint and wake-up registration with the transition (T4)', async () => {
    const h = harness();
    h.define('waits', {
      handle: async () => ({
        kind: 'waiting',
        wakeup: { anyOf: [{ kind: 'timer', at: '2026-11-06T00:00:00.000Z' }] },
        checkpoint: { seen: 1 },
      }),
    });
    const t = await h.delegate((await h.instance('waits')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    const snap = await h.tasks.getTask(t.taskId, alice);
    expect(snap).toMatchObject({
      status: 'waiting',
      waitingOn: { anyOf: [{ kind: 'timer' }] },
    });
    const [cp, wakeups] = await h.store.transaction(
      async (tx) =>
        [
          await tx.get('checkpoints', t.taskId),
          await tx.find('wakeups', { where: { taskId: t.taskId } }),
        ] as const,
    );
    expect(cp?.value).toEqual({
      taskId: t.taskId,
      data: { seen: 1 },
      version: 1,
    });
    expect(wakeups.map((w) => w.value)).toMatchObject([
      { status: 'armed', dueAt: '2026-11-06T00:00:00.000Z' },
    ]);
    expect(await executions(h, t.taskId)).toEqual([['yielded', 1, 1]]);
  });

  it('the pool never runs more than its size', async () => {
    const h = harness({ poolSize: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.define('slow', {
      handle: async () => (await gate, { kind: 'completed', output: null }),
    });
    const inst = await h.instance('slow');
    for (let i = 0; i < 5; i++) await h.delegate(inst.id, {}, `k${i}`);
    await h.runtime.tick();
    await h.runtime.tick();
    expect(h.runtime.activeCount).toBe(2);
    release();
    await h.runtime.runUntilIdle();
    expect(h.runtime.activeCount).toBe(0);
  });
});

describe('CapabilityAccess (AC-16 invocation part, step keys)', () => {
  const calls = (fn: Agent['handle']): Agent => ({ handle: fn });

  it('undeclared capability, unknown operation and missing step key fail typed; external ops get a stable derived key', async () => {
    const h = harness();
    const outcomes: string[] = [];
    h.define(
      'caller',
      calls(async (inv, ctx) => {
        for (const attempt of [
          () => ctx.capabilities.invoke('reasoning', 'complete', {}),
          () => ctx.capabilities.invoke('notification', 'teleport', {}),
          () =>
            ctx.capabilities.invoke('notification', 'notify', { title: 't' }),
        ]) {
          outcomes.push(await code(attempt()));
        }
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          { title: 't' },
          { stepKey: 'notify:once' },
        );
        if (inv.attempt === 1) throw new Error('crash after the effect');
        return { kind: 'completed', output: null };
      }),
    );
    await h.delegate((await h.instance('caller')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    h.clock.advanceBy(1_000);
    await h.runtime.runUntilIdle();
    expect(outcomes.slice(0, 3)).toEqual([
      'CapabilityNotDeclared',
      'UnsupportedOperation',
      'SchemaViolation',
    ]);
    const keys = h.cap.calls
      .filter((c) => c.operation === 'notify')
      .map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]); // replay reuses the key, so an idempotent provider deduplicates
  });

  it('every operation takes a fresh policy decision', async () => {
    const h = harness();
    h.define(
      'notifier',
      calls(async (_inv, ctx) => {
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          {},
          { stepKey: 's' },
        );
        return { kind: 'completed', output: null };
      }),
    );
    h.pdp.denied.add('notification:notify');
    const t = await h.delegate((await h.instance('notifier')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    expect((await h.tasks.getTask(t.taskId, alice)).outcome?.code).toBe(
      'PermissionDenied',
    );
    expect(h.cap.calls).toEqual([]);
  });
});

describe('failures stay inside the pool (FEAT-037.2)', () => {
  it('a disposition that cannot be written is reported, not thrown; the lease expiry then recovers the task', async () => {
    const inner = sqliteTempStore();
    let broken = false;
    const store: Store = {
      durability: inner.durability,
      close: () => inner.close(),
      transaction: (fn) =>
        broken
          ? Promise.reject(new Error('store down'))
          : inner.transaction(fn),
    };
    const reported: string[] = [];
    const h = harness({
      store,
      runtime: { onError: (e) => reported.push(e.code) },
    });
    h.define('writer', {
      handle: async (inv) => {
        if (inv.attempt === 1) broken = true; // the store goes away before the result is written
        return { kind: 'completed', output: { attempt: inv.attempt } };
      },
    });
    const t = await h.delegate((await h.instance('writer')).id, {}, 'k');
    await h.runtime.tick();
    await h.runtime.idle(); // would reject (an unhandled rejection) before FEAT-037.2
    expect(reported).toEqual(['Internal']);
    expect(h.runtime.activeCount).toBe(0);

    broken = false;
    expect(await status(h, t.taskId)).toBe('running'); // the lease has not expired yet
    h.clock.advanceBy(1_001);
    await h.runtime.runUntilIdle();
    expect(await h.tasks.getResult(t.taskId, alice)).toEqual({ attempt: 2 });
  });

  it('an activation past maxActivationMs is aborted with Timeout and, if it ignores the signal, fenced and retried', async () => {
    const h = harness({
      cancelGraceMs: 20,
      runtime: { maxActivationMs: 30 },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reasons: string[] = [];
    h.define('hung', {
      handle: async (inv, ctx) => {
        if (inv.attempt > 1)
          return { kind: 'completed', output: { attempt: inv.attempt } };
        ctx.signal.addEventListener('abort', () =>
          reasons.push((ctx.signal.reason as { code: string }).code),
        );
        await gate; // ignores the signal
        return { kind: 'completed', output: 'late' };
      },
    });
    const t = await h.delegate((await h.instance('hung')).id, {}, 'k');
    await h.runtime.tick();
    await vi.waitFor(async () =>
      expect(await status(h, t.taskId)).toBe('assigned'),
    );
    expect(reasons).toEqual(['Timeout']);
    expect(h.runtime.activeCount).toBe(0);
    await h.runtime.runUntilIdle();
    expect(await h.tasks.getResult(t.taskId, alice)).toEqual({ attempt: 2 });
    expect(await executions(h, t.taskId)).toEqual([
      ['lost', 1, 1],
      ['succeeded', 1, 2],
    ]);
    release(); // the late first attempt is fenced and changes nothing
    await h.runtime.idle();
    expect(await h.tasks.getResult(t.taskId, alice)).toEqual({ attempt: 2 });
  });

  it('limits validate maxActivationMs', async () => {
    const { resolveLimits } = await import('../src/limits.js');
    expect(resolveLimits().maxActivationMs).toBe(600_000);
    expect(() => resolveLimits({ maxActivationMs: 10 })).toThrow(
      /maxActivationMs/,
    );
  });
});
