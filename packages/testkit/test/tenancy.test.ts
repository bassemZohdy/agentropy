// FEAT-027.7: tenant isolation and quotas (M2-11, R-16), backing threat-model rows TM-04/TM-05.
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { createLocalApp, type TenantQuota } from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const a1: TrustedPrincipal = { id: 'a1', type: 'user', tenantId: 'tenant-a' };
const b1: TrustedPrincipal = { id: 'b1', type: 'user', tenantId: 'tenant-b' };

const def = (id: string): AgentDefinition => ({
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
});

function setup(quotas: Record<string, TenantQuota>) {
  const clock = new FakeClock('2026-11-05T00:00:00.000Z');
  const app = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
    quotas: (tenantId) => quotas[tenantId],
  });
  // Waits for a timer so tasks stay active until the clock moves.
  const sleeper: Agent = {
    handle: async (inv) =>
      inv.activation === 1
        ? {
            kind: 'waiting',
            wakeup: {
              anyOf: [{ kind: 'timer', at: '2026-11-05T00:10:00.000Z' }],
            },
            checkpoint: null,
          }
        : { kind: 'completed', output: null },
  };
  app.define(def('sleeper'), sleeper);
  const instance = (p: TrustedPrincipal, key: string) =>
    app.createInstance(
      {
        definition: { id: 'sleeper', version: '1.0.0' },
        ownerId: p.id,
        idempotencyKey: key,
      },
      p,
    );
  const delegate = (p: TrustedPrincipal, instanceId: string, key: string) =>
    app.delegate(
      {
        target: { instanceId },
        input: {},
        idempotencyKey: key,
        correlationId: key,
      },
      p,
    );
  return { app, clock, instance, delegate };
}

describe('tenant quotas (M2-11)', () => {
  it('maxActiveTasks refuses new work with QuotaExceeded until tasks finish; replays and other tenants are unaffected', async () => {
    const { app, clock, instance, delegate } = setup({
      'tenant-a': { maxActiveTasks: 2 },
    });
    const ia = await instance(a1, 'ia');
    const ib = await instance(b1, 'ib');
    const t1 = await delegate(a1, ia.id, 'k1');
    await delegate(a1, ia.id, 'k2');
    const refused = await code(delegate(a1, ia.id, 'k3'));
    expect(refused).toBe('QuotaExceeded');
    // An idempotent replay of an accepted request is still answered.
    expect((await delegate(a1, ia.id, 'k1')).taskId).toBe(t1.taskId);
    // Tenant B has its own (absent) quota.
    for (let i = 0; i < 4; i++) await delegate(b1, ib.id, `b${i}`);
    await app.runUntilIdle();
    clock.advanceBy(10 * 60 * 1000);
    await app.runUntilIdle();
    expect((await delegate(a1, ia.id, 'k3')).taskId).toBeDefined();
  });

  it('maxAcceptsPerMinute is a rolling window', async () => {
    const { clock, instance, delegate } = setup({
      'tenant-a': { maxAcceptsPerMinute: 3 },
    });
    const ia = await instance(a1, 'ia');
    for (let i = 0; i < 3; i++) await delegate(a1, ia.id, `k${i}`);
    expect(await code(delegate(a1, ia.id, 'k3'))).toBe('QuotaExceeded');
    clock.advanceBy(61_000);
    expect(await code(delegate(a1, ia.id, 'k3'))).toBe('no-error');
  });

  it('maxInstances counts live instances; retiring one frees a slot', async () => {
    const { app, instance } = setup({ 'tenant-a': { maxInstances: 2 } });
    const first = await instance(a1, 'i1');
    await instance(a1, 'i2');
    expect(await code(instance(a1, 'i3'))).toBe('QuotaExceeded');
    // Replay of an existing instance request is not a new instance.
    expect((await instance(a1, 'i1')).id).toBe(first.id);
    await app.retireInstance(first.id, a1);
    expect(await code(instance(a1, 'i3'))).toBe('no-error');
    expect(await code(instance(b1, 'other-tenant'))).toBe('no-error');
  });

  it('QuotaExceeded is retryable and names the quota, nothing more', async () => {
    const { instance, delegate } = setup({ 'tenant-a': { maxActiveTasks: 0 } });
    const ia = await instance(a1, 'ia');
    try {
      await delegate(a1, ia.id, 'k');
      expect.fail('expected QuotaExceeded');
    } catch (err) {
      expect((err as { toJSON(): unknown }).toJSON()).toEqual({
        code: 'QuotaExceeded',
        category: 'limit',
        retryable: true,
        message: 'Tenant quota maxActiveTasks (0) reached',
        details: { quota: 'maxActiveTasks', limit: 0 },
      });
    }
  });
});

describe('tenant isolation (TM-04)', () => {
  it('one tenant cannot read, list, cancel, share or delegate into another tenant’s resources', async () => {
    const { app, instance, delegate } = setup({});
    const ia = await instance(a1, 'ia');
    const ta = await delegate(a1, ia.id, 'k');
    expect(await code(app.getTask(ta.taskId, b1))).toBe('NotFound');
    expect(await code(app.cancel(ta.taskId, b1))).toBe('NotFound');
    expect((await app.listTasks({}, b1)).tasks).toEqual([]);
    expect(await app.listInstances(b1, 'a1')).toEqual([]);
    expect(await code(app.shareInstance(ia.id, ['b1'], b1))).toBe('NotFound');
    expect(await code(delegate(b1, ia.id, 'x'))).toBe('TenantMismatch');
    expect((await app.listInbox({}, b1)).entries).toEqual([]);
  });
});
