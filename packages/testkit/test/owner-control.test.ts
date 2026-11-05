// FEAT-027.1: owner visibility and control (M2-05, R-13) — list and filter own tasks, cancel, suspend/resume,
// drain and retire instances, with owner/tenant access control. Runs through the createLocalApp facade.
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
const mallory: TrustedPrincipal = { id: 'mal', type: 'user', tenantId: 't-2' };
const ops: TrustedPrincipal = { id: 'ops', type: 'service', tenantId: 't-1' };

function def(id: string): AgentDefinition {
  return {
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
  };
}

function setup() {
  const clock = new FakeClock('2026-11-05T00:00:00.000Z');
  const app = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
  });
  // A worker that waits on a timer, so tasks stay non-terminal until the clock moves.
  const sleeper: Agent = {
    handle: async (inv) =>
      inv.activation === 1
        ? {
            kind: 'waiting',
            wakeup: {
              anyOf: [{ kind: 'timer', at: '2026-11-05T01:00:00.000Z' }],
            },
            checkpoint: null,
          }
        : { kind: 'completed', output: 'done' },
  };
  app.define(def('sleeper'), sleeper);
  const instance = (owner: TrustedPrincipal, key: string) =>
    app.createInstance(
      {
        definition: { id: 'sleeper', version: '1.0.0' },
        ownerId: owner.id,
        idempotencyKey: key,
      },
      owner,
    );
  const delegate = (instanceId: string, key: string, caller = alice) =>
    app.delegate(
      {
        target: { instanceId },
        input: {},
        idempotencyKey: key,
        correlationId: key,
      },
      caller,
    );
  return { app, clock, instance, delegate };
}

describe('owner task visibility (M2-05, R-13)', () => {
  it('lists only the caller’s tasks, filters by instance and status, and pages with a cursor', async () => {
    const { app, instance, delegate } = setup();
    const a1 = await instance(alice, 'a1');
    const a2 = await instance(alice, 'a2');
    const b1 = await instance(bob, 'b1');
    const t1 = await delegate(a1.id, 'k1');
    const t2 = await delegate(a1.id, 'k2');
    const t3 = await delegate(a2.id, 'k3');
    await delegate(b1.id, 'k4', bob);
    await app.runUntilIdle();
    await app.cancel(t2.taskId, alice);

    const all = await app.listTasks({}, alice);
    expect(all.tasks.map((t) => t.taskId)).toEqual([
      t1.taskId,
      t2.taskId,
      t3.taskId,
    ]);
    expect(
      (await app.listTasks({ instanceId: a1.id }, alice)).tasks.map(
        (t) => t.taskId,
      ),
    ).toEqual([t1.taskId, t2.taskId]);
    expect(
      (await app.listTasks({ status: ['cancelled'] }, alice)).tasks.map(
        (t) => t.status,
      ),
    ).toEqual(['cancelled']);
    const page1 = await app.listTasks({ limit: 2 }, alice);
    const page2 = await app.listTasks(
      { limit: 2, cursor: page1.cursor },
      alice,
    );
    expect([...page1.tasks, ...page2.tasks].map((t) => t.taskId)).toEqual(
      all.tasks.map((t) => t.taskId),
    );
    expect((await app.listTasks({}, bob)).tasks).toHaveLength(1);
    expect((await app.listTasks({}, mallory)).tasks).toEqual([]);
    expect((await app.listTasks({}, ops)).tasks).toHaveLength(4);
    expect(await code(app.listTasks({ cursor: 'x' }, alice))).toBe(
      'SchemaViolation',
    );
  });

  it('owners list their own instances; another owner’s list is empty unless the caller is a trusted service', async () => {
    const { app, instance } = setup();
    await instance(alice, 'a1');
    await instance(bob, 'b1');
    expect((await app.listInstances(alice)).map((i) => i.ownerId)).toEqual([
      'alice',
    ]);
    expect(await app.listInstances(alice, 'bob')).toEqual([]);
    expect(await app.listInstances(ops, 'bob')).toHaveLength(1);
  });
});

describe('instance control', () => {
  it('only the owner (or a trusted service) can suspend, resume, drain or retire; others get NotFound', async () => {
    const { app, instance } = setup();
    const a1 = await instance(alice, 'a1');
    for (const p of [bob, mallory]) {
      expect(await code(app.suspendInstance(a1.id, p))).toBe('NotFound');
      expect(await code(app.drainInstance(a1.id, p))).toBe('NotFound');
      expect(await code(app.retireInstance(a1.id, p))).toBe('NotFound');
    }
    expect((await app.suspendInstance(a1.id, ops)).state).toBe('suspended');
    expect((await app.resumeInstance(a1.id, alice)).state).toBe('available');
  });

  it('drain refuses new tasks, lets running work finish, then retires the instance', async () => {
    const { app, clock, instance, delegate } = setup();
    const a1 = await instance(alice, 'a1');
    const t1 = await delegate(a1.id, 'k1');
    await app.runUntilIdle();
    expect((await app.getTask(t1.taskId, alice)).status).toBe('waiting');

    const draining = await app.drainInstance(a1.id, alice);
    expect([draining.state, draining.draining]).toEqual(['available', true]);
    expect(await code(delegate(a1.id, 'k2'))).toBe('InstanceUnavailable');
    // A retry of an already accepted request still returns its original handle.
    expect((await delegate(a1.id, 'k1')).taskId).toBe(t1.taskId);

    clock.advanceBy(60 * 60 * 1000);
    await app.runUntilIdle();
    expect(await app.getResult(t1.taskId, alice)).toBe('done');
    expect((await app.listInstances(alice))[0]!.state).toBe('retired');
  });

  it('drain with no active tasks retires at once; retire without force refuses active tasks', async () => {
    const { app, instance, delegate } = setup();
    const idle = await instance(alice, 'idle');
    expect((await app.drainInstance(idle.id, alice)).state).toBe('retired');
    expect(await code(app.drainInstance(idle.id, alice))).toBe('InvalidState');

    const busy = await instance(alice, 'busy');
    await delegate(busy.id, 'k');
    await app.runUntilIdle();
    expect(await code(app.retireInstance(busy.id, alice))).toBe('InvalidState');
    expect(
      (await app.retireInstance(busy.id, alice, { force: true })).state,
    ).toBe('retired');
  });

  it('a suspended instance defers its wake-ups and accepts no new tasks until resumed', async () => {
    const { app, clock, instance, delegate } = setup();
    const a1 = await instance(alice, 'a1');
    const t1 = await delegate(a1.id, 'k1');
    await app.runUntilIdle();
    await app.suspendInstance(a1.id, alice);
    expect(await code(delegate(a1.id, 'k2'))).toBe('InstanceUnavailable');
    clock.advanceBy(60 * 60 * 1000);
    await app.runUntilIdle();
    expect((await app.getTask(t1.taskId, alice)).status).toBe('waiting');
    await app.resumeInstance(a1.id, alice);
    await app.runUntilIdle();
    expect(await app.getResult(t1.taskId, alice)).toBe('done');
  });
});
