// TaskService acceptance (FEAT-017.1): AC-03 idempotent delegation, AC-04 no state leakage, AC-09 identity
// cases at the service boundary, AC-15 concurrent instances, guard order and limits.
import { describe, expect, it } from 'vitest';
import {
  MemoryStore,
  alice,
  bob,
  code,
  completes,
  harness,
  mallory,
} from './harness.js';

describe('delegate (AC-03, R-20)', () => {
  it('returns an async handle; the result is available after execution', async () => {
    const h = harness();
    h.define('echo', {
      handle: async (inv) => ({
        kind: 'completed',
        output: { echo: inv.input },
      }),
    });
    const inst = await h.instance('echo');
    const handle = await h.delegate(inst.id, { a: 1 }, 'k1');
    expect(handle).toMatchObject({
      agentInstanceId: inst.id,
      status: 'assigned',
      definition: { id: 'echo', version: '1.0.0' },
      durability: 'durable-execution',
    });
    expect(await code(h.tasks.getResult(handle.taskId, alice))).toBe(
      'NotReady',
    );
    await h.runtime.runUntilIdle();
    expect(await h.tasks.getResult(handle.taskId, alice)).toEqual({
      echo: { a: 1 },
    });
  });

  it('a lost response is resolved by re-sending the same key, even after the target is suspended (AC-03)', async () => {
    const h = harness();
    h.define('echo', completes());
    const inst = await h.instance('echo');
    const first = await h.delegate(inst.id, { a: 1 }, 'dup'); // response "dropped" by the transport
    await h.instances.suspend(inst.id, alice);
    expect(await h.delegate(inst.id, { a: 1 }, 'dup')).toEqual(first);
    expect((await h.tasks.getTaskByIdempotencyKey('dup', alice)).taskId).toBe(
      first.taskId,
    );
    expect(await code(h.delegate(inst.id, { a: 2 }, 'dup'))).toBe(
      'IdempotencyConflict',
    );
    expect(await code(h.delegate(inst.id, { a: 1 }, 'fresh'))).toBe(
      'InstanceUnavailable',
    );
  });

  it('concurrent duplicates create one task', async () => {
    const h = harness();
    h.define('echo', completes());
    const inst = await h.instance('echo');
    const handles = await Promise.all(
      Array.from({ length: 5 }, () => h.delegate(inst.id, { a: 1 }, 'race')),
    );
    expect(new Set(handles.map((x) => x.taskId)).size).toBe(1);
  });

  it('validates input against the definition schema', async () => {
    const h = harness();
    h.define('typed', completes(), {
      inputSchema: { type: 'object', required: ['symbol'] },
    });
    expect(
      await code(h.delegate((await h.instance('typed')).id, {}, 'k')),
    ).toBe('SchemaViolation');
  });

  it('a durable profile on a non-durable store is refused (AC-13 service part)', async () => {
    const h = harness({ store: new MemoryStore() });
    h.define('task-agent', completes());
    expect(
      await code(h.delegate((await h.instance('task-agent')).id, {}, 'k')),
    ).toBe('GuaranteeUnavailable');
    h.define('helper', completes(), {
      profile: { id: 'specialist', version: '1.0.0' },
    });
    expect(
      (await h.delegate((await h.instance('helper')).id, {}, 'k2')).durability,
    ).toBe('none');
  });

  it('enforces delegation depth and fan-out limits', async () => {
    const h = harness({ limits: { maxDepth: 1, maxFanOut: 2 } });
    h.define('echo', completes());
    const inst = await h.instance('echo');
    const root = await h.delegate(inst.id, {}, 'root');
    const child = await h.delegate(inst.id, {}, 'c1', alice, {
      parentTaskId: root.taskId,
    });
    await h.delegate(inst.id, {}, 'c2', alice, { parentTaskId: root.taskId });
    expect(
      await code(
        h.delegate(inst.id, {}, 'c3', alice, { parentTaskId: root.taskId }),
      ),
    ).toBe('FanOutExceeded');
    expect(
      await code(
        h.delegate(inst.id, {}, 'gc', alice, { parentTaskId: child.taskId }),
      ),
    ).toBe('DelegationDepthExceeded');
  });
});

describe('identity and visibility (AC-04, AC-09 service part)', () => {
  it('unauthenticated, cross-tenant, expired grant and policy denial fail before any state is read', async () => {
    const h = harness();
    h.define('echo', completes());
    const inst = await h.instance('echo');
    expect(
      await code(
        h.delegate(inst.id, {}, 'k', { id: '', type: 'user', tenantId: '' }),
      ),
    ).toBe('Unauthenticated');
    expect(await code(h.delegate(inst.id, {}, 'k', mallory))).toBe(
      'TenantMismatch',
    );
    h.grants.status.set('grant-1', 'expired');
    expect(
      await code(
        h.delegate(inst.id, {}, 'k', {
          ...alice,
          delegatedAuthorityRef: 'grant-1',
        }),
      ),
    ).toBe('AuthorityExpired');
    h.pdp.denied.add('delegation:delegate');
    expect(await code(h.delegate(inst.id, {}, 'k'))).toBe('PermissionDenied');
    h.pdp.denied.clear();
    h.pdp.down = true;
    expect(await code(h.delegate(inst.id, {}, 'k'))).toBe(
      'PolicyDecisionUnavailable',
    );
  });

  it('an unauthorized caller on a terminal task gets NotFound, not InvalidState (AC-04)', async () => {
    const h = harness();
    h.define('echo', completes());
    const handle = await h.delegate((await h.instance('echo')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    expect(await code(h.tasks.cancel(handle.taskId, alice))).toBe(
      'InvalidState',
    );
    expect(await code(h.tasks.cancel(handle.taskId, bob))).toBe('NotFound');
    expect(await code(h.tasks.cancel(handle.taskId, mallory))).toBe('NotFound');
    expect(await code(h.tasks.getTask(handle.taskId, bob))).toBe('NotFound');
  });
});

describe('cancel and results', () => {
  it('cancelling a queued task is T10 and aborts the queued execution (E7)', async () => {
    const h = harness();
    h.define('echo', completes());
    const handle = await h.delegate((await h.instance('echo')).id, {}, 'k');
    expect(
      (await h.tasks.cancel(handle.taskId, alice, 'user changed mind')).status,
    ).toBe('cancelled');
    await h.runtime.runUntilIdle();
    expect(await code(h.tasks.getResult(handle.taskId, alice))).toBe(
      'TaskCancelled',
    );
    const execs = await h.store.transaction((tx) =>
      tx.find<{ state: string }>('executions', {
        where: { taskId: handle.taskId },
      }),
    );
    expect(execs.map((e) => e.value.state)).toEqual(['aborted']);
  });

  it('every transition is revisioned and emits one outbox event (R-04)', async () => {
    const h = harness();
    h.define('echo', completes());
    const handle = await h.delegate((await h.instance('echo')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    const events = await h.store.transaction((tx) =>
      tx.find<{ revision: number; payload: { status: string } }>('outbox', {
        where: { aggregateId: handle.taskId },
      }),
    );
    expect(
      events.map((e) => [e.value.revision, e.value.payload.status]),
    ).toEqual([
      [1, 'created'],
      [2, 'assigned'],
      [3, 'running'],
      [4, 'completed'],
    ]);
    expect((await h.tasks.getTask(handle.taskId, alice)).revision).toBe(4);
  });
});

describe('instances (AC-15 runtime part)', () => {
  it('two instances of one definition run tasks concurrently with no shared state', async () => {
    const h = harness();
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.define('worker', {
      handle: async (inv, ctx) => {
        seen.push(ctx.agentInstanceId);
        await gate;
        return {
          kind: 'completed',
          output: { instance: ctx.agentInstanceId, input: inv.input },
        };
      },
    });
    const a = await h.instance('worker');
    const b = await h.instance('worker');
    const ta = await h.delegate(a.id, { n: 1 }, 'a');
    const tb = await h.delegate(b.id, { n: 2 }, 'b');
    await h.runtime.tick();
    expect(h.runtime.activeCount).toBe(2);
    release();
    await h.runtime.idle();
    expect(new Set(seen)).toEqual(new Set([a.id, b.id]));
    expect(await h.tasks.getResult(ta.taskId, alice)).toEqual({
      instance: a.id,
      input: { n: 1 },
    });
    expect(await h.tasks.getResult(tb.taskId, alice)).toEqual({
      instance: b.id,
      input: { n: 2 },
    });
  });
});

describe('scheduling timestamps (FEAT-038.3)', () => {
  it('a delegation deadline is stored as UTC ISO-8601; free text and zone-less times are SchemaViolation', async () => {
    const h = harness();
    h.define('d', {
      handle: async () => ({ kind: 'completed', output: null }),
    });
    const inst = await h.instance('d');
    const t = await h.delegate(inst.id, {}, 'ok', alice, {
      deadline: '2026-11-06T02:30:00+02:00',
    });
    const stored = await h.store.transaction((tx) =>
      tx.get<{ deadline?: string }>('tasks', t.taskId),
    );
    expect(stored?.value.deadline).toBe('2026-11-06T00:30:00.000Z');
    for (const [i, bad] of ['tomorrow', '2026-11-06T02:30:00', 42].entries())
      expect(
        await code(
          h.delegate(inst.id, {}, `bad-${i}`, alice, { deadline: bad }),
        ),
      ).toBe('SchemaViolation');
  });
});
