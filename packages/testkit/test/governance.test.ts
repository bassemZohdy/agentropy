// TASK-026.2: governance and ownership (D-03, D-08) — who may delegate to an instance, how sharing interacts with
// task ownership and visibility, and the drain/retire policy.
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
const carol: TrustedPrincipal = { id: 'carol', type: 'user', tenantId: 't-1' };
const mallory: TrustedPrincipal = { id: 'mal', type: 'user', tenantId: 't-2' };
const ops: TrustedPrincipal = { id: 'ops', type: 'service', tenantId: 't-1' };

const def = (
  id: string,
  over: Partial<AgentDefinition> = {},
): AgentDefinition => ({
  id,
  version: '1.0.0',
  displayName: id,
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id, version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
  ...over,
});

function setup() {
  const pdp = new FakePolicy();
  const app = createLocalApp({
    store: sqliteTempStore(),
    pdp,
    now: new FakeClock('2026-11-05T00:00:00.000Z').iso,
    profiles: BUILTIN_PROFILES,
  });
  app.define(def('worker'), {
    handle: async (inv) => ({ kind: 'completed', output: inv.input }),
  });
  let targetId = '';
  const router: Agent = {
    handle: async (_inv, ctx) => {
      await ctx.capabilities.invoke(
        'delegation',
        'delegate',
        { target: { instanceId: targetId }, input: { via: 'agent' } },
        { stepKey: 'fwd' },
      );
      return { kind: 'completed', output: 'routed' };
    },
  };
  app.define(
    def('router', {
      capabilities: [{ id: 'delegation', versionRange: '^1.0.0' }],
    }),
    router,
  );
  const instance = (id: string, owner: TrustedPrincipal, key: string) =>
    app.createInstance(
      {
        definition: { id, version: '1.0.0' },
        ownerId: owner.id,
        idempotencyKey: key,
      },
      owner,
    );
  const delegate = (
    instanceId: string,
    caller: TrustedPrincipal,
    key: string,
  ) =>
    app.delegate(
      {
        target: { instanceId },
        input: { from: caller.id },
        idempotencyKey: key,
        correlationId: key,
      },
      caller,
    );
  return {
    app,
    pdp,
    instance,
    delegate,
    setTarget: (id: string) => (targetId = id),
  };
}

describe('D-08: delegation to another user’s instance', () => {
  it('is NotFound until the owner shares it; sharing is owner-only and tenant-scoped', async () => {
    const { app, instance, delegate } = setup();
    const w = await instance('worker', alice, 'w');
    expect(await code(delegate(w.id, bob, 'b1'))).toBe('NotFound');
    expect(await code(delegate(w.id, mallory, 'm1'))).toBe('TenantMismatch');
    expect(await code(app.shareInstance(w.id, ['bob'], bob))).toBe('NotFound');
    expect(await code(app.shareInstance(w.id, ['bob'], ops))).toBe(
      'PermissionDenied',
    );
    const shared = await app.shareInstance(
      w.id,
      ['bob', 'bob', 'alice'],
      alice,
    );
    expect(shared.sharedWith).toEqual(['bob']);
    const tb = await delegate(w.id, bob, 'b2');
    expect(await code(delegate(w.id, carol, 'c1'))).toBe('NotFound');
    // Trusted services may delegate without a share (still subject to policy).
    await delegate(w.id, ops, 'o1');
    await app.runUntilIdle();
    expect(await app.getResult(tb.taskId, bob)).toEqual({ from: 'bob' });
    // Revoking the share stops new work; existing tasks are unaffected.
    await app.shareInstance(w.id, [], alice);
    expect(await code(delegate(w.id, bob, 'b3'))).toBe('NotFound');
    expect((await app.getTask(tb.taskId, bob)).status).toBe('completed');
  });

  it('task visibility: the delegator sees its own tasks, the owner sees every task on the instance, others nothing', async () => {
    const { app, instance, delegate } = setup();
    const w = await instance('worker', alice, 'w');
    await app.shareInstance(w.id, ['bob', 'carol'], alice);
    const tb = await delegate(w.id, bob, 'b');
    const tc = await delegate(w.id, carol, 'c');
    await app.runUntilIdle();
    expect((await app.listTasks({}, bob)).tasks.map((t) => t.taskId)).toEqual([
      tb.taskId,
    ]);
    expect((await app.listTasks({}, carol)).tasks.map((t) => t.taskId)).toEqual(
      [tc.taskId],
    );
    expect(
      (await app.listTasks({ instanceId: w.id }, alice)).tasks,
    ).toHaveLength(2);
    expect(await code(app.getTask(tc.taskId, bob))).toBe('NotFound');
    expect(await code(app.cancel(tb.taskId, carol))).toBe('NotFound');
  });

  it('an agent may delegate to instances of its own owner, or to ones shared with its owner', async () => {
    const { app, instance, delegate, setTarget } = setup();
    const aliceWorker = await instance('worker', alice, 'aw');
    const bobWorker = await instance('worker', bob, 'bw');
    const aliceRouter = await instance('router', alice, 'ar');

    setTarget(aliceWorker.id);
    const ok = await delegate(aliceRouter.id, alice, 'r1');
    await app.runUntilIdle();
    expect(await app.getResult(ok.taskId, alice)).toBe('routed');

    setTarget(bobWorker.id);
    const denied = await delegate(aliceRouter.id, alice, 'r2');
    await app.runUntilIdle();
    expect((await app.getTask(denied.taskId, alice)).outcome?.code).toBe(
      'NotFound',
    );

    await app.shareInstance(bobWorker.id, ['alice'], bob);
    const allowed = await delegate(aliceRouter.id, alice, 'r3');
    await app.runUntilIdle();
    expect(await app.getResult(allowed.taskId, alice)).toBe('routed');
    // Bob owns the instance, so he sees the child task alice's agent created there.
    expect(
      (await app.listTasks({ instanceId: bobWorker.id }, bob)).tasks,
    ).toHaveLength(1);
  });
});

describe('D-03: drain and retire policy', () => {
  it('retire is refused with active tasks, force retires; drain is the graceful path; a retired instance accepts nothing', async () => {
    const { app, instance, delegate } = setup();
    const sleeper: Agent = {
      handle: async (inv) =>
        inv.activation === 1
          ? {
              kind: 'waiting',
              wakeup: {
                anyOf: [{ kind: 'timer', at: '2026-11-06T00:00:00.000Z' }],
              },
              checkpoint: null,
            }
          : { kind: 'completed', output: null },
    };
    app.define(def('sleeper'), sleeper);
    const s = await instance('sleeper', alice, 's');
    const t = await delegate(s.id, alice, 't');
    await app.runUntilIdle();
    expect(await code(app.retireInstance(s.id, alice))).toBe('InvalidState');
    const draining = await app.drainInstance(s.id, alice);
    expect(draining.draining).toBe(true);
    await app.cancel(t.taskId, alice);
    expect((await app.listInstances(alice))[0]!.state).toBe('retired');
    expect(await code(delegate(s.id, alice, 't2'))).toBe('InvalidState');
    expect(await code(app.resumeInstance(s.id, alice))).toBe('InvalidState');
  });
});

describe('FIX-057: instance lifecycle is governed and audited', () => {
  it('a user cannot create an instance for another owner; a trusted service can', async () => {
    const { app } = setup();
    const create = (caller: TrustedPrincipal, ownerId: string, key: string) =>
      app.createInstance(
        {
          definition: { id: 'worker', version: '1.0.0' },
          ownerId,
          idempotencyKey: key,
        },
        caller,
      );
    expect(await code(create(alice, 'bob', 'k1'))).toBe('PermissionDenied');
    expect(await app.listInstances(bob)).toEqual([]);
    expect(await app.listInstances(alice)).toEqual([]);
    const made = await create(ops, 'bob', 'k2');
    expect(made.ownerId).toBe('bob');
    expect((await app.listInstances(bob)).map((i) => i.id)).toEqual([made.id]);
    expect((await create(alice, 'alice', 'k3')).ownerId).toBe('alice');
  });

  it('a denied lifecycle call changes nothing and an allowed one is audited', async () => {
    const { app, pdp, instance } = setup();
    const created = await instance('worker', alice, 'k');
    const state = async () => (await app.listInstances(alice))[0]!;
    const calls: [string, (c: TrustedPrincipal) => Promise<unknown>][] = [
      ['agent:suspend', (c) => app.suspendInstance(created.id, c)],
      ['agent:resume', (c) => app.resumeInstance(created.id, c)],
      ['agent:share', (c) => app.shareInstance(created.id, ['bob'], c)],
      ['agent:drain', (c) => app.drainInstance(created.id, c)],
      ['agent:retire', (c) => app.retireInstance(created.id, c)],
    ];
    for (const [action] of calls) pdp.denied.add(action);
    pdp.denied.add('agent:create');
    expect(await code(instance('worker', alice, 'k-denied'))).toBe(
      'PermissionDenied',
    );
    const before = await state();
    for (const [, run] of calls)
      expect(await code(run(alice))).toBe('PermissionDenied');
    expect(await state()).toEqual(before);
    expect(await app.listInstances(alice)).toHaveLength(1);
    pdp.denied.clear();

    // Allowed, in an order the state machine accepts: suspend, resume, share, drain (retires at once: nothing active).
    for (const [, run] of calls.slice(0, 4)) await run(alice);
    expect((await state()).state).toBe('retired');
    const log = await app.auditLog.query({ tenantId: 't-1' }, ops);
    expect(
      log.filter((e) => e.type.startsWith('instance.')).map((e) => e.type),
    ).toEqual([
      'instance.create',
      'instance.suspend',
      'instance.resume',
      'instance.share',
      'instance.drain',
    ]);
    expect(log.find((e) => e.type === 'instance.suspend')).toMatchObject({
      action: 'agent:suspend',
      decision: 'allow',
      resource: { type: 'agent-instance', id: created.id },
      principalId: 'alice',
    });
  });

  it('a retire is policy checked and audited too', async () => {
    const { app, pdp, instance } = setup();
    const created = await instance('worker', alice, 'k');
    pdp.denied.add('agent:retire');
    expect(await code(app.retireInstance(created.id, alice))).toBe(
      'PermissionDenied',
    );
    expect((await app.listInstances(alice))[0]!.state).toBe('available');
    pdp.denied.clear();
    await app.retireInstance(created.id, alice);
    const log = await app.auditLog.query(
      { tenantId: 't-1', type: 'instance.retire' },
      ops,
    );
    expect(log).toHaveLength(1);
  });
});
