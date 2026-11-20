// FEAT-070: a parent that is cancelled or fails takes its open children with it (Agent v1 revision 15): children that
// are not running end at once, a running child is asked to stop and fenced like any cancelled task, a task of another
// parent is untouched, and a parent that completes leaves its children alone.
import { describe, expect, it, vi } from 'vitest';
import { alice, code, completes, harness } from '../../runtime/test/harness.js';

type H = ReturnType<typeof harness>;

const view = async (h: H, taskId: string) => h.tasks.getTask(taskId, alice);
const status = async (h: H, taskId: string) => (await view(h, taskId)).status;

/** A handler that waits for a timer a long way off: its task stays `waiting` until something ends it. */
const sleeps = {
  handle: async () => ({
    kind: 'waiting' as const,
    wakeup: {
      anyOf: [{ kind: 'timer' as const, at: '2030-01-01T00:00:00.000Z' }],
    },
    checkpoint: null,
  }),
};

async function tree(h: H) {
  h.define('parent', sleeps);
  h.define('child', sleeps);
  const parentInst = await h.instance('parent');
  const childInst = await h.instance('child');
  return { parentInst, childInst };
}

describe('cancel and failure propagate to open children (FEAT-070)', () => {
  it('FEAT-070: cancelling a waiting parent cancels its running child and fences the child’s late result', async () => {
    const h = harness({ cancelGraceMs: 20 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.define('parent', sleeps);
    h.define('stubborn', {
      handle: async () => (await gate, { kind: 'completed', output: 'late' }),
    });
    const parent = await h.delegate((await h.instance('parent')).id, {}, 'p');
    await h.runtime.tick();
    await h.runtime.idle();
    expect(await status(h, parent.taskId)).toBe('waiting');
    const child = await h.delegate(
      (await h.instance('stubborn')).id,
      {},
      'c',
      alice,
      { parentTaskId: parent.taskId },
    );
    await h.runtime.tick();
    expect(await status(h, child.taskId)).toBe('running');

    await h.tasks.cancel(parent.taskId, alice);
    expect(await status(h, parent.taskId)).toBe('cancelled');
    // The child is asked to stop; the worker sees the request through the store on its next heartbeat.
    expect((await view(h, child.taskId)).cancelRequestedAt).toBeDefined();
    await h.runtime.renewLeases();
    await vi.waitFor(async () =>
      expect(await status(h, child.taskId)).toBe('cancelled'),
    );
    release();
    await h.runtime.idle();
    expect(await status(h, child.taskId)).toBe('cancelled');
    expect(await status(h, parent.taskId)).toBe('cancelled');
    expect(
      (
        await h.store.transaction((tx) =>
          tx.get<{ output?: unknown }>('tasks', child.taskId),
        )
      )?.value.output,
    ).toBeUndefined();
  });

  it('FEAT-070: a task of another parent is untouched', async () => {
    const h = harness();
    const { parentInst, childInst } = await tree(h);
    h.define('worker', completes('done'));
    const p1 = await h.delegate(parentInst.id, {}, 'p1');
    const p2 = await h.delegate(parentInst.id, {}, 'p2');
    await h.runtime.tick();
    await h.runtime.idle();
    const c1 = await h.delegate(childInst.id, {}, 'c1', alice, {
      parentTaskId: p1.taskId,
    });
    const c2 = await h.delegate(childInst.id, {}, 'c2', alice, {
      parentTaskId: p2.taskId,
    });
    const free = await h.delegate((await h.instance('worker')).id, {}, 'free');
    await h.runtime.tick();
    await h.runtime.idle();
    await h.tasks.cancel(p1.taskId, alice);
    expect(await status(h, c1.taskId)).toBe('cancelled');
    expect((await view(h, c1.taskId)).outcome).toMatchObject({
      code: 'Cancelled',
    });
    expect(await status(h, p2.taskId)).toBe('waiting');
    expect(await status(h, c2.taskId)).toBe('waiting');
    await h.runtime.runUntilIdle();
    expect(await status(h, free.taskId)).toBe('completed');
  });

  it('FEAT-070: a failed parent cancels its waiting child and grandchild', async () => {
    const h = harness();
    const { parentInst, childInst } = await tree(h);
    const root = await h.delegate(parentInst.id, {}, 'root');
    await h.runtime.tick();
    await h.runtime.idle();
    const child = await h.delegate(childInst.id, {}, 'c', alice, {
      parentTaskId: root.taskId,
    });
    await h.runtime.tick();
    await h.runtime.idle();
    const grand = await h.delegate(childInst.id, {}, 'g', alice, {
      parentTaskId: child.taskId,
    });
    await h.runtime.tick();
    await h.runtime.idle();
    expect(await status(h, grand.taskId)).toBe('waiting');
    // The parent fails (here as a deadline would end it, T9).
    await h.store.transaction(async (tx) =>
      h.tasks.terminate(
        tx,
        (await tx.get('tasks', root.taskId))! as never,
        'failed',
        'T9',
        { code: 'Timeout', message: 'deadline' },
      ),
    );
    expect(await status(h, root.taskId)).toBe('failed');
    expect(await status(h, child.taskId)).toBe('cancelled');
    expect(await status(h, grand.taskId)).toBe('cancelled');
    expect((await view(h, grand.taskId)).outcome?.message).toMatch(/parent/);
  });

  it('FEAT-070: a parent that completes leaves its open children alone', async () => {
    const h = harness();
    h.define('parent', completes('done'));
    h.define('child', sleeps);
    const parent = await h.delegate((await h.instance('parent')).id, {}, 'p');
    const child = await h.delegate(
      (await h.instance('child')).id,
      {},
      'c',
      alice,
      {
        parentTaskId: parent.taskId,
      },
    );
    await h.runtime.runUntilIdle();
    expect(await status(h, parent.taskId)).toBe('completed');
    expect(await status(h, child.taskId)).toBe('waiting');
  });
});

describe('no child is accepted under a parent that has ended (FIX-081)', () => {
  it('FIX-081: delegating under a cancelled parent is InvalidState and stores no child; a retry of a child accepted before still gets its handle', async () => {
    const h = harness();
    const { parentInst, childInst } = await tree(h);
    const parent = await h.delegate(parentInst.id, {}, 'p');
    await h.runtime.tick();
    await h.runtime.idle();
    const early = await h.delegate(childInst.id, {}, 'early', alice, {
      parentTaskId: parent.taskId,
    });
    await h.tasks.cancel(parent.taskId, alice);
    expect(await status(h, parent.taskId)).toBe('cancelled');
    expect(
      await code(
        h.delegate(childInst.id, {}, 'late', alice, {
          parentTaskId: parent.taskId,
        }),
      ),
    ).toBe('InvalidState');
    const children = await h.store.transaction((tx) =>
      tx.find('tasks', { where: { parentTaskId: parent.taskId } }),
    );
    expect(children.map((c) => c.id)).toEqual([early.taskId]);
    // Idempotency replay comes before state: the same request gets its original answer.
    expect(
      (
        await h.delegate(childInst.id, {}, 'early', alice, {
          parentTaskId: parent.taskId,
        })
      ).taskId,
    ).toBe(early.taskId);
  });

  it('FIX-081: a completed parent accepts no new child either', async () => {
    const h = harness();
    h.define('parent', completes('done'));
    h.define('child', sleeps);
    const parent = await h.delegate((await h.instance('parent')).id, {}, 'p');
    await h.runtime.runUntilIdle();
    expect(await status(h, parent.taskId)).toBe('completed');
    expect(
      await code(
        h.delegate((await h.instance('child')).id, {}, 'c', alice, {
          parentTaskId: parent.taskId,
        }),
      ),
    ).toBe('InvalidState');
  });

  it('FIX-081: a handler that ignores its abort signal and delegates after its task was cancelled and fenced gets InvalidState; no child is created', async () => {
    const h = harness({ cancelGraceMs: 20, builtin: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let late: Promise<unknown> | undefined;
    h.define('child', sleeps);
    const childInst = await h.instance('child');
    h.define(
      'stubborn',
      {
        handle: async (_inv, ctx) => {
          await gate; // ignores ctx.signal
          late = ctx.capabilities.invoke(
            'delegation',
            'delegate',
            { target: { instanceId: childInst.id }, input: {} },
            { stepKey: 'late-child' },
          );
          await late.catch(() => undefined);
          return { kind: 'completed', output: 'late' };
        },
      },
      { profile: { id: 'coordinator', version: '1.0.0' } },
    );
    const parent = await h.delegate((await h.instance('stubborn')).id, {}, 'p');
    await h.runtime.tick();
    expect(await status(h, parent.taskId)).toBe('running');
    await h.tasks.cancel(parent.taskId, alice);
    await h.runtime.renewLeases();
    await vi.waitFor(async () =>
      expect(await status(h, parent.taskId)).toBe('cancelled'),
    );
    release();
    await vi.waitFor(() => expect(late).toBeDefined());
    expect(await code(late!)).toBe('InvalidState');
    await h.runtime.idle();
    const children = await h.store.transaction((tx) =>
      tx.find('tasks', { where: { parentTaskId: parent.taskId } }),
    );
    expect(children).toEqual([]);
  });
});
