// FEAT-022.2: mandatory M1 security acceptance — SEC-01 (ADR-0024 dispatch gate), SEC-02 (stale or lost
// authority), SEC-03 (mandatory audit intent), SEC-04 (spoofed claims, PEPs, default deny) and AC-09.
// Runs offline with the testkit fakes (clock, policy, grants, audit, fault injector) and a temp SQLite store.
import {
  AgentropyError,
  type AgentMessage,
  type AuditEvent,
  type PolicyDecision,
  type PolicyRequest,
  type RouteBinding,
  type TrustedPrincipal,
} from '@agentropy/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeDirectTarget, FaultInjector } from '../src/index.js';
import {
  AgentRuntime,
  AuditForwarder,
  DirectCommunicationProvider,
  type AuditIntentRow,
  type DispatchGate,
} from '../../runtime/src/index.js';
import {
  SqliteStore,
  alice,
  code,
  completes,
  harness,
  mallory,
} from '../../runtime/test/harness.js';

type H = ReturnType<typeof harness>;

const gate = (h: H, taskId: string) =>
  h.store
    .transaction((tx) => tx.get<DispatchGate>('gates', taskId))
    .then((d) => d?.value);
const status = async (h: H, taskId: string) =>
  (await h.tasks.getTask(taskId, alice)).status;
const executions = (h: H, taskId: string) =>
  h.store
    .transaction((tx) =>
      tx.find<{ state: string }>('executions', { where: { taskId } }),
    )
    .then((rows) => rows.map((r) => r.value.state));
const auditRows = (h: H) =>
  h.store
    .transaction((tx) => tx.find<AuditIntentRow>('audit', { orderBy: 'seq' }))
    .then((rows) => rows.map((r) => r.value));
const dispatchChecks = (h: H) =>
  h.pdp.requests.filter((r) => r.action === 'task:dispatch').length;
const settle = async (h: H) => {
  for (let i = 0; i < 3; i++) {
    await h.wakeups.poll();
    await h.runtime.runUntilIdle();
  }
};
const SECOND = 1000;
const withGrant = (p: TrustedPrincipal, ref: string): TrustedPrincipal => ({
  ...p,
  delegatedAuthorityRef: ref,
});

/** A handler that counts invocations, so tests can prove nothing protected ran. */
function counted(h: H, id = 'job') {
  const calls = { n: 0 };
  h.define(id, {
    handle: async () => {
      calls.n++;
      return { kind: 'completed', output: { ok: true } };
    },
  });
  return calls;
}

describe('SEC-01: policy decision unavailable before dispatch (ADR-0024 gate)', () => {
  it('keeps the task assigned with a durable gate, no lease and no handler call, and retries on a bounded schedule', async () => {
    const h = harness();
    const calls = counted(h);
    const t = await h.delegate((await h.instance('job')).id, {}, 'k');
    h.pdp.down = true;
    await h.runtime.runUntilIdle();
    expect(await status(h, t.taskId)).toBe('assigned');
    expect(await executions(h, t.taskId)).toEqual(['queued']);
    expect(calls.n).toBe(0);
    expect(await gate(h, t.taskId)).toMatchObject({
      reason: 'policy-indeterminate',
      attempt: 1,
      nextCheckAt: '2026-11-05T00:00:01.000Z',
    });
    // No busy retries: until nextCheckAt nothing calls the PDP again.
    const before = dispatchChecks(h);
    for (let i = 0; i < 5; i++) await h.runtime.tick();
    expect(dispatchChecks(h)).toBe(before);
    h.clock.advanceBy(SECOND);
    await h.runtime.tick();
    expect(dispatchChecks(h)).toBe(before + 1);
    expect(await gate(h, t.taskId)).toMatchObject({
      attempt: 2,
      nextCheckAt: '2026-11-05T00:00:03.000Z',
    });
    // The gate is a scheduler record, not a lifecycle edge: no task revision bump, no TaskEvent.
    expect((await h.tasks.getTask(t.taskId, alice)).revision).toBe(2);
    const audit = (await auditRows(h)).filter(
      (r) => r.event.type === 'task.dispatch',
    );
    expect(audit.map((r) => r.event.decision)).toEqual(['error', 'error']);
  });

  it('a timed-out or malformed policy decision fails closed the same way', async () => {
    class OddPolicy {
      readonly requests: PolicyRequest[] = [];
      mode: 'malformed' | 'hang' = 'malformed';
      async decide(r: PolicyRequest): Promise<PolicyDecision> {
        this.requests.push(r);
        if (r.action !== 'task:dispatch') return { effect: 'allow' };
        if (this.mode === 'hang') return new Promise(() => {});
        return { effect: 'maybe' } as unknown as PolicyDecision;
      }
    }
    const h = harness();
    counted(h);
    const pdp = new OddPolicy();
    (h.tasks.o as { pdp: unknown }).pdp = pdp;
    const t = await h.delegate((await h.instance('job')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    expect((await gate(h, t.taskId))?.reason).toBe('policy-indeterminate');

    pdp.mode = 'hang';
    const fast = new AgentRuntime({
      tasks: h.tasks,
      implementations: h.implementations,
      capabilityProviders: new Map([[h.cap.id, h.cap]]),
      pdpTimeoutMs: 10,
    });
    h.clock.advanceBy(SECOND);
    await fast.tick();
    expect(await gate(h, t.taskId)).toMatchObject({
      reason: 'policy-indeterminate',
      attempt: 2,
    });
    expect(await status(h, t.taskId)).toBe('assigned');
  });

  it('gate state survives a restart and the task dispatches once policy is available again', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentropy-sec01-')), 's.db');
    const first = harness({ store: new SqliteStore({ path }) });
    counted(first);
    const t = await first.delegate((await first.instance('job')).id, {}, 'k');
    first.pdp.down = true;
    await first.runtime.runUntilIdle();
    expect((await gate(first, t.taskId))?.reason).toBe('policy-indeterminate');

    const second = harness({ store: new SqliteStore({ path }) });
    const calls = counted(second);
    expect((await gate(second, t.taskId))?.attempt).toBe(1);
    await second.runtime.runUntilIdle();
    expect(calls.n).toBe(0);
    second.clock.advanceBy(SECOND);
    await second.runtime.runUntilIdle();
    expect(calls.n).toBe(1);
    expect(await status(second, t.taskId)).toBe('completed');
    expect(await gate(second, t.taskId)).toBeUndefined();
    const dispatched = (await auditRows(second)).filter(
      (r) => r.event.type === 'task.dispatch',
    );
    expect(dispatched.map((r) => r.event.decision)).toEqual(['error', 'allow']);
    expect(dispatched[1]!.event.details).toMatchObject({
      after: 'policy-indeterminate',
    });
  });

  it('bounded retries end in an operator-visible block instead of spinning', async () => {
    const h = harness();
    counted(h);
    const t = await h.delegate((await h.instance('job')).id, {}, 'k');
    h.pdp.down = true;
    for (let i = 0; i < 12; i++) {
      await h.runtime.tick();
      h.clock.advanceBy(10 * 60 * SECOND);
    }
    expect(await gate(h, t.taskId)).toMatchObject({
      reason: 'policy-indeterminate',
      attempt: 8,
      nextCheckAt: null,
    });
    expect(dispatchChecks(h)).toBe(8);
  });

  it('cancel and deadline still apply while gated', async () => {
    const h = harness();
    counted(h);
    const id = (await h.instance('job')).id;
    const a = await h.delegate(id, {}, 'a');
    const b = await h.delegate(id, {}, 'b', alice, {
      deadline: '2026-11-05T00:00:30.000Z',
    });
    h.pdp.down = true;
    await h.runtime.runUntilIdle();
    h.pdp.down = false;
    expect((await h.tasks.cancel(a.taskId, alice)).status).toBe('cancelled');
    expect(await gate(h, a.taskId)).toBeUndefined();
    h.clock.advanceBy(60 * SECOND);
    await h.runtime.tick();
    const snap = await h.tasks.getTask(b.taskId, alice);
    expect([snap.status, snap.outcome?.code]).toEqual(['failed', 'Timeout']);
  });

  it('two schedulers racing over one store lease the task once (gate and lease CAS)', async () => {
    const h = harness();
    const calls = counted(h);
    const t = await h.delegate((await h.instance('job')).id, {}, 'k');
    const other = new AgentRuntime({
      tasks: h.tasks,
      implementations: h.implementations,
      capabilityProviders: new Map([[h.cap.id, h.cap]]),
    });
    await Promise.all([h.runtime.tick(), other.tick(), h.runtime.tick()]);
    await Promise.all([h.runtime.idle(), other.idle()]);
    expect(calls.n).toBe(1);
    expect(await status(h, t.taskId)).toBe('completed');
  });
});

describe('SEC-02: grant expired or revoked after acceptance', () => {
  it('before dispatch: the task is retained, never auto-renewed, and resumes only after verified reauthorization', async () => {
    const h = harness();
    const calls = counted(h);
    const caller = withGrant(alice, 'g-1');
    const t = await h.delegate((await h.instance('job')).id, {}, 'k', caller);
    h.grants.status.set('g-1', 'expired');
    await h.runtime.runUntilIdle();
    expect(await gate(h, t.taskId)).toMatchObject({
      reason: 'authority-expired',
      nextCheckAt: null,
      grantRef: 'g-1',
    });
    h.clock.advanceBy(24 * 60 * 60 * SECOND);
    await h.runtime.runUntilIdle();
    expect(calls.n).toBe(0);
    // Reauthorizing with the same dead grant is refused; a revoked grant also blocks.
    expect(await code(h.tasks.reauthorize(t.taskId, caller))).toBe(
      'AuthorityExpired',
    );
    expect(await code(h.tasks.reauthorize(t.taskId, mallory))).toBe('NotFound');
    h.grants.status.set('g-2', 'valid');
    await h.tasks.reauthorize(t.taskId, withGrant(alice, 'g-2'));
    // A fresh policy decision is still required at the next pass.
    h.pdp.denied.add('task:dispatch');
    await h.runtime.runUntilIdle();
    expect(await gate(h, t.taskId)).toMatchObject({
      reason: 'policy-denied',
      grantRef: 'g-2',
    });
    h.pdp.denied.clear();
    await h.tasks.reauthorize(t.taskId, withGrant(alice, 'g-2'));
    await h.runtime.runUntilIdle();
    expect(calls.n).toBe(1);
    expect(await status(h, t.taskId)).toBe('completed');
  });

  it('during execution: the next protected effect is denied, the task waits behind the gate, and committed effects are kept, not duplicated', async () => {
    const h = harness({ builtin: true });
    const runs: string[] = [];
    h.define(
      'payer',
      {
        handle: async (_inv, ctx) => {
          runs.push('run');
          await ctx.capabilities.invoke(
            'notification',
            'notify',
            { severity: 'normal', title: 'step a', body: 'a' },
            { stepKey: 'a' },
          );
          if (runs.length === 1) h.grants.status.set('g-1', 'revoked');
          await ctx.capabilities.invoke(
            'notification',
            'notify',
            { severity: 'normal', title: 'step b', body: 'b' },
            { stepKey: 'b' },
          );
          return { kind: 'completed', output: null };
        },
      },
      { profile: { id: 'task', version: '1.0.0' } },
    );
    const t = await h.delegate(
      (await h.instance('payer')).id,
      {},
      'k',
      withGrant(alice, 'g-1'),
    );
    await settle(h);
    expect(await status(h, t.taskId)).toBe('assigned');
    expect(await gate(h, t.taskId)).toMatchObject({
      reason: 'authority-revoked',
      nextCheckAt: null,
    });
    expect((await h.inbox.list({}, alice)).entries.map((e) => e.title)).toEqual(
      ['step a'],
    );
    await settle(h);
    expect(runs).toHaveLength(1);
    h.grants.status.set('g-2', 'valid');
    await h.tasks.reauthorize(t.taskId, withGrant(alice, 'g-2'));
    await settle(h);
    expect(await status(h, t.taskId)).toBe('completed');
    expect(runs).toHaveLength(2);
    expect((await h.inbox.list({}, alice)).entries.map((e) => e.title)).toEqual(
      ['step a', 'step b'],
    );
  });

  it('every protected capability call takes a fresh policy decision (no stale Allow)', async () => {
    const h = harness({ builtin: true });
    h.define('twice', {
      handle: async (_inv, ctx) => {
        for (const k of ['x', 'y'])
          await ctx.capabilities.invoke(
            'notification',
            'notify',
            { severity: 'low', title: k, body: k },
            { stepKey: k },
          );
        return { kind: 'completed', output: null };
      },
    });
    await h.delegate((await h.instance('twice')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    expect(
      h.pdp.requests.filter((r) => r.action === 'notification:notify'),
    ).toHaveLength(2);
  });
});

describe('SEC-03: mandatory audit intent', () => {
  it('a failed intent write means no task, no idempotency record and a typed error; a retry then succeeds once', async () => {
    const faults = new FaultInjector();
    const h = harness({ faults });
    counted(h);
    const id = (await h.instance('job')).id;
    faults.failNext('audit.intent');
    expect(await code(h.delegate(id, {}, 'k'))).toBe('AuditCommitUnavailable');
    expect(await code(h.tasks.getTaskByIdempotencyKey('k', alice))).toBe(
      'NotFound',
    );
    expect(
      await h.store.transaction((tx) => tx.find('tasks', {})),
    ).toHaveLength(0);
    const t = await h.delegate(id, {}, 'k');
    expect((await h.delegate(id, {}, 'k')).taskId).toBe(t.taskId);
    expect(
      (await auditRows(h)).filter((r) => r.event.type === 'task.accept'),
    ).toHaveLength(1);
  });

  it('cancel and human decisions are not committed when their intent fails; a failed gate intent dispatches nothing', async () => {
    const faults = new FaultInjector();
    const h = harness({ faults });
    const calls = counted(h);
    const id = (await h.instance('job')).id;
    const t = await h.delegate(id, {}, 'k');
    faults.failNext('audit.intent');
    expect(await code(h.tasks.cancel(t.taskId, alice))).toBe(
      'AuditCommitUnavailable',
    );
    expect(await status(h, t.taskId)).toBe('assigned');

    h.pdp.down = true;
    faults.failNext('audit.intent');
    await h.runtime.tick();
    expect(await gate(h, t.taskId)).toBeUndefined();
    expect(calls.n).toBe(0);
    expect(await status(h, t.taskId)).toBe('assigned');
  });

  it('crash after a committed intent but before forwarding: replay after restart, deduplicated by auditId', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentropy-sec03-')), 's.db');
    const faults = new FaultInjector();
    const first = harness({ store: new SqliteStore({ path }), faults });
    counted(first);
    faults.failNext('audit.markForwarded', 1_000);
    await first.delegate((await first.instance('job')).id, {}, 'k');
    await first.runtime.runUntilIdle();
    const committed = await auditRows(first);
    expect(committed.length).toBeGreaterThan(0);
    expect(committed.every((r) => r.forwarded === 0)).toBe(true);

    // A sink that deduplicates on the stable auditId, standing in for an idempotent audit store.
    const received: AuditEvent[] = [...first.audit.events];
    const sink = {
      seen: new Set(received.map((e) => String(e.details?.['auditId']))),
      async record(e: AuditEvent) {
        received.push(e);
        this.seen.add(String(e.details?.['auditId']));
      },
    };
    const store = new SqliteStore({ path });
    const forwarder = new AuditForwarder({ store, sink });
    expect(await forwarder.drain()).toBe(committed.length);
    expect(await forwarder.drain()).toBe(0);
    expect(sink.seen.size).toBe(committed.length);
    expect(received.length).toBeGreaterThan(committed.length);
  });

  it('audit details are redacted before they are stored', async () => {
    const h = harness();
    await h.store.transaction((tx) =>
      h.tasks.audit(tx, alice, {
        type: 'probe',
        action: 'probe',
        resource: { type: 'x', id: 'y' },
        decision: 'allow',
        details: { reason: 'ok', apiKey: 'sk-123', payload: { pan: '4111' } },
      }),
    );
    const [row] = await auditRows(h);
    expect(row!.event.details).toEqual({ reason: 'ok' });
  });
});

describe('SEC-04 and AC-09: spoofed claims, ingress and capability PEPs, default deny', () => {
  it('AC-09: forged envelope actor/tenant are replaced by the trusted caller', async () => {
    const target = new FakeDirectTarget();
    const provider = new DirectCommunicationProvider(
      target,
      'durable-acceptance',
    );
    const forged: AgentMessage = {
      schemaVersion: 1,
      kind: 'command',
      name: 'ping',
      messageId: 'm-1',
      correlationId: 'c-1',
      idempotencyKey: 'm-1',
      tenantId: 't-2',
      actor: { principalId: 'root', principalType: 'service' },
      createdAt: '2026-11-05T00:00:00.000Z',
      payload: { traceparent: '00-forged-01' },
    };
    await provider.send({} as RouteBinding, forged, {
      caller: alice,
      correlationId: 'c-1',
    });
    expect(target.received[0]).toMatchObject({
      tenantId: 't-1',
      actor: { principalId: 'alice', principalType: 'user' },
    });
  });

  it('AC-09: cross-tenant delegate → TenantMismatch, expired grant → AuthorityExpired, no principal → Unauthenticated', async () => {
    const h = harness();
    counted(h);
    const id = (await h.instance('job')).id;
    expect(await code(h.delegate(id, {}, 'x', mallory))).toBe('TenantMismatch');
    h.grants.status.set('dead', 'expired');
    expect(await code(h.delegate(id, {}, 'y', withGrant(alice, 'dead')))).toBe(
      'AuthorityExpired',
    );
    expect(
      await code(h.delegate(id, {}, 'z', {} as unknown as TrustedPrincipal)),
    ).toBe('Unauthenticated');
    expect(
      await code(
        h.delegate(id, {}, 'w', {
          id: 'eve',
          type: 'user',
        } as TrustedPrincipal),
      ),
    ).toBe('Unauthenticated');
  });

  it('claims inside the payload (actor, tenant, trace) have no authorization effect', async () => {
    const h = harness();
    h.define('echo', completes());
    const id = (await h.instance('echo')).id;
    const t = await h.delegate(
      id,
      { actor: 'root', tenantId: 't-2', traceparent: '00-x-01' },
      'k',
    );
    await h.runtime.runUntilIdle();
    const dispatch = h.pdp.requests.find((r) => r.action === 'task:dispatch')!;
    expect(dispatch.principal).toMatchObject({ id: 'alice', tenantId: 't-1' });
    expect(await code(h.tasks.getTask(t.taskId, mallory))).toBe('NotFound');
  });

  it('a capability PEP deny stops the effect; an undeclared capability is refused before any decision', async () => {
    const h = harness({ builtin: true });
    h.define('noisy', {
      handle: async (inv, ctx) => {
        const which = (inv.input as { which: string }).which;
        await ctx.capabilities.invoke(
          which === 'undeclared' ? 'human-input' : 'notification',
          which === 'undeclared' ? 'requestAction' : 'notify',
          { severity: 'low', title: 't', body: 'b' },
          { stepKey: 's' },
        );
        return { kind: 'completed', output: null };
      },
    });
    const id = (await h.instance('noisy')).id;
    h.pdp.denied.add('notification:notify');
    const denied = await h.delegate(id, { which: 'denied' }, 'a');
    const undeclared = await h.delegate(id, { which: 'undeclared' }, 'b');
    await h.runtime.runUntilIdle();
    expect((await h.tasks.getTask(denied.taskId, alice)).outcome?.code).toBe(
      'PermissionDenied',
    );
    expect(
      (await h.tasks.getTask(undeclared.taskId, alice)).outcome?.code,
    ).toBe('CapabilityNotDeclared');
    expect((await h.inbox.list({}, alice)).entries).toEqual([]);
    expect(
      h.pdp.requests.some((r) => r.action === 'human-input:requestAction'),
    ).toBe(false);
  });

  it('snapshots and serialized errors carry no grant references or secrets', async () => {
    const h = harness();
    counted(h);
    const t = await h.delegate(
      (await h.instance('job')).id,
      {},
      'k',
      withGrant(alice, 'grant-secret-ref'),
    );
    expect(
      JSON.stringify(await h.tasks.getTask(t.taskId, alice)),
    ).not.toContain('grant-secret-ref');
    const err = new AgentropyError('AuthorityExpired', 'expired', {
      details: { status: 'expired', bearerToken: 'abc' },
    });
    expect(JSON.stringify(err)).not.toContain('abc');
  });
});
