// TASK-026.3 (part): SEC-06 credential rotation (D-17) and the SEC-05 M2 part — tenant-scoped audit access and
// hash-chain tamper evidence (D-21).
import {
  AgentropyError,
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type CredentialProvider,
  type PolicyDecisionPoint,
  type PolicyRequest,
  type ToolDescriptor,
  type ToolInvocationContext,
  type TrustedPrincipal,
} from '@agentropy/core';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CachingPolicyDecisionPoint,
  createActivationIngress,
  DefaultToolExecutor,
  DirectToolProvider,
  InMemoryToolRegistry,
  ToolProviderRegistry,
  createLocalApp,
} from '../../runtime/src/index.js';
import {
  SqliteStore,
  code,
  sqliteTempStore,
} from '../../runtime/test/harness.js';
import { FakeAudit, FakeClock, FakePolicy } from '../src/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const auditor: TrustedPrincipal = { id: 'aud', type: 'user', tenantId: 't-1' };
const mallory: TrustedPrincipal = { id: 'mal', type: 'user', tenantId: 't-2' };

const SECRET_V1 = 'sk-live-ORIGINAL-0001';
const SECRET_V2 = 'sk-live-ROTATED-0002';

/** Tenant-scoped vault fake: opaque references, resolved just in time, never returned in errors. */
class FakeVault implements CredentialProvider {
  readonly secrets = new Map<string, string>();
  resolutions = 0;
  async resolve(
    ref: string,
    ctx: { tenantId: string; principal: TrustedPrincipal; purpose: string },
  ): Promise<unknown> {
    this.resolutions++;
    const secret = this.secrets.get(`${ctx.tenantId}/${ref}`);
    if (!secret)
      throw new AgentropyError('AuthorityExpired', 'Credential unavailable', {
        details: { kind: 'credential', status: 'expired' },
      });
    return { apiKey: secret };
  }
}

const payout: ToolDescriptor = {
  id: 'finance.payout',
  version: '1.0.0',
  description: 'Pay out',
  inputSchema: true,
  effect: 'external',
  idempotency: 'keyed',
  permission: 'tool:finance.payout:call',
};

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

async function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'agentropy-auth-')), 's.db');
  const clock = new FakeClock('2026-11-05T00:00:00.000Z');
  const pdp = new FakePolicy();
  const audit = new FakeAudit();
  const vault = new FakeVault();
  const usedKeys: string[] = [];
  const ledger = new Map<string, string>();
  const registry = new InMemoryToolRegistry(
    { pdp, audit, now: clock.iso },
    () => true,
  );
  const providers = new ToolProviderRegistry();
  providers.register(
    new DirectToolProvider({
      // Keyed provider: one payment per idempotency key, as Tool v1 requires for `keyed` external tools.
      pay: (_i: unknown, ctx: ToolInvocationContext) => {
        const key = ctx.idempotencyKey!;
        if (!ledger.has(key)) {
          usedKeys.push((ctx.credential as { apiKey: string }).apiKey);
          ledger.set(key, `pay-${ledger.size + 1}`);
        }
        return { paymentId: ledger.get(key) };
      },
    }),
  );
  const rec = await registry.register(
    payout,
    [
      {
        bindingId: 'direct',
        toolId: payout.id,
        toolVersion: payout.version,
        providerId: 'direct',
        providerVersion: '1.0.0',
        config: { function: 'pay' },
        credentialRef: 'payments-api',
        default: true,
      },
    ],
    { publisher: 'acme', source: 'test' },
    alice,
  );
  void rec;
  await registry.activate({ id: payout.id, version: payout.version }, alice);
  const app = createLocalApp({
    store: new SqliteStore({ path }),
    pdp,
    audit,
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
    tools: {
      registry,
      providers,
      executor: new DefaultToolExecutor({
        pdp,
        audit,
        now: clock.iso,
        registry,
        providers,
        credentials: vault,
      }),
    },
  });
  const payer: Agent<{ payments: number }> = {
    handle: async (inv, ctx) => {
      const ids: string[] = [];
      for (let i = 1; i <= inv.input.payments; i++) {
        const r = await ctx.capabilities.invoke<
          unknown,
          { output: { paymentId: string } }
        >(
          'tool-use',
          'call',
          { toolId: payout.id, input: { n: i } },
          { stepKey: `pay-${i}` },
        );
        ids.push(r.output.paymentId);
      }
      return { kind: 'completed', output: ids };
    },
  };
  app.define(
    def('payer', {
      capabilities: [{ id: 'tool-use', versionRange: '^1.0.0' }],
      tools: [{ id: payout.id, versionRange: '^1.0.0' }],
    }),
    payer,
  );
  const inst = await app.createInstance(
    {
      definition: { id: 'payer', version: '1.0.0' },
      ownerId: 'alice',
      idempotencyKey: 'p',
    },
    alice,
  );
  const run = (payments: number, key: string) =>
    app.delegate(
      {
        target: { instanceId: inst.id },
        input: { payments },
        idempotencyKey: key,
        correlationId: key,
      },
      alice,
    );
  return { app, path, pdp, vault, usedKeys, run, clock };
}

describe('SEC-06: missing or rotated credentials (D-17)', () => {
  it('a missing credential blocks the protected call, keeps the durable task, persists no secret; refresh + reauthorize resumes', async () => {
    const s = await setup();
    const t = await s.run(1, 'k');
    await s.app.runUntilIdle();
    const snap = await s.app.getTask(t.taskId, alice);
    expect(snap.status).toBe('assigned');
    const gate = await s.app.store.transaction((tx) =>
      tx.get<{ reason: string }>('gates', t.taskId),
    );
    expect(gate?.value.reason).toBe('authority-expired');
    expect(s.usedKeys).toEqual([]);

    s.vault.secrets.set('t-1/payments-api', SECRET_V1);
    // Nothing resumes on its own: an authorized principal must re-establish authority.
    await s.app.runUntilIdle();
    expect((await s.app.getTask(t.taskId, alice)).status).toBe('assigned');
    await s.app.reauthorize(t.taskId, alice);
    await s.app.runUntilIdle();
    expect(await s.app.getResult(t.taskId, alice)).toEqual(['pay-1']);
    expect(s.usedKeys).toEqual([SECRET_V1]);
    // The secret never reaches the database file.
    expect(readFileSync(s.path).toString('latin1')).not.toContain(SECRET_V1);
  });

  it('credentials are resolved per invocation, so a rotation takes effect on the next call without a restart', async () => {
    const s = await setup();
    s.vault.secrets.set('t-1/payments-api', SECRET_V1);
    const first = await s.run(1, 'a');
    await s.app.runUntilIdle();
    s.vault.secrets.set('t-1/payments-api', SECRET_V2);
    const second = await s.run(1, 'b');
    await s.app.runUntilIdle();
    expect(await s.app.getResult(first.taskId, alice)).toEqual(['pay-1']);
    expect(await s.app.getResult(second.taskId, alice)).toEqual(['pay-2']);
    expect(s.usedKeys).toEqual([SECRET_V1, SECRET_V2]);
    expect(s.vault.resolutions).toBe(2);
  });

  it('a credential revoked mid-task blocks only the remaining calls; completed payments are not repeated after refresh', async () => {
    const s = await setup();
    s.vault.secrets.set('t-1/payments-api', SECRET_V1);
    const real = s.vault.resolve.bind(s.vault);
    let calls = 0;
    s.vault.resolve = async (ref, ctx) => {
      if (++calls === 2) s.vault.secrets.delete('t-1/payments-api');
      return real(ref, ctx);
    };
    const t = await s.run(2, 'k');
    await s.app.runUntilIdle();
    expect((await s.app.getTask(t.taskId, alice)).status).toBe('assigned');
    s.vault.secrets.set('t-1/payments-api', SECRET_V2);
    await s.app.reauthorize(t.taskId, alice);
    await s.app.runUntilIdle();
    // The resumed attempt replays pay-1 with the same derived key; the keyed provider returns the original payment.
    expect(s.usedKeys).toEqual([SECRET_V1, SECRET_V2]);
    expect(await s.app.getResult(t.taskId, alice)).toEqual(['pay-1', 'pay-2']);
  });
});

describe('SEC-05 (M2 part): audit access and tamper evidence (D-21)', () => {
  it('audit reads are tenant-scoped and need audit:read; other tenants get NotFound without disclosure', async () => {
    const s = await setup();
    s.vault.secrets.set('t-1/payments-api', SECRET_V1);
    await s.run(1, 'k');
    await s.app.runUntilIdle();
    const events = await s.app.auditLog.query({ tenantId: 't-1' }, auditor);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['task.accept']),
    );
    expect(JSON.stringify(events)).not.toContain(SECRET_V1);
    expect(await code(s.app.auditLog.query({ tenantId: 't-1' }, mallory))).toBe(
      'NotFound',
    );
    expect(await code(s.app.auditLog.query({ tenantId: 't-2' }, auditor))).toBe(
      'NotFound',
    );
    s.pdp.denied.add('audit:read');
    expect(await code(s.app.auditLog.query({ tenantId: 't-1' }, auditor))).toBe(
      'PermissionDenied',
    );
  });

  it('verify detects an altered or deleted audit row', async () => {
    const s = await setup();
    s.vault.secrets.set('t-1/payments-api', SECRET_V1);
    await s.run(1, 'a');
    await s.run(1, 'b');
    await s.app.runUntilIdle();
    const ok = await s.app.auditLog.verify('t-1', auditor);
    expect(ok).toMatchObject({ ok: true });
    const rows = await s.app.store.transaction((tx) =>
      tx.find<{ auditId: string; event: { decision: string } }>('audit', {
        orderBy: 'seq',
      }),
    );
    // Tamper: flip a recorded decision.
    const target = rows[1]!;
    await s.app.store.transaction((tx) =>
      tx.update('audit', target.id, target.revision, {
        ...target.value,
        event: { ...target.value.event, decision: 'deny' },
      }),
    );
    expect(await s.app.auditLog.verify('t-1', auditor)).toEqual({
      ok: false,
      brokenAt: target.value.auditId,
    });
    // Restore, then delete a row: the next link no longer matches.
    await s.app.store.transaction(async (tx) => {
      const cur = (await tx.get<typeof target.value>('audit', target.id))!;
      await tx.update('audit', cur.id, cur.revision, target.value);
    });
    expect(await s.app.auditLog.verify('t-1', auditor)).toMatchObject({
      ok: true,
    });
    await s.app.store.transaction(async (tx) => {
      const cur = (await tx.get('audit', rows[0]!.id))!;
      await tx.remove('audit', cur.id, cur.revision);
    });
    expect(await s.app.auditLog.verify('t-1', auditor)).toEqual({
      ok: false,
      brokenAt: rows[1]!.value.auditId,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// D-15 grant narrowing and audit chain, D-18 PEP parity, D-19 decision cache, D-20 revocation checkpoint.

class NarrowingGrants {
  readonly status = new Map<string, 'valid' | 'expired' | 'revoked'>();
  readonly narrowed: { from: string; to: string; agentInstanceId: string }[] =
    [];
  refuse = false;
  async check(ref: string) {
    return this.status.get(ref) ?? 'valid';
  }
  async narrow(
    ref: string,
    scope: { tenantId: string; agentInstanceId: string },
  ): Promise<string> {
    if (this.refuse) throw new Error('scope not grantable');
    const to = `${ref}>${scope.agentInstanceId}`;
    this.narrowed.push({
      from: ref,
      to,
      agentInstanceId: scope.agentInstanceId,
    });
    return to;
  }
}

function delegationSetup(
  opts: { grants?: NarrowingGrants; pdp?: PolicyDecisionPoint } = {},
) {
  const clock = new FakeClock('2026-11-05T00:00:00.000Z');
  const pdp = opts.pdp ?? new FakePolicy();
  const audit = new FakeAudit();
  const app = createLocalApp({
    store: sqliteTempStore(),
    pdp,
    audit,
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
    ...(opts.grants ? { grants: opts.grants } : {}),
  });
  let target = '';
  let gate: Promise<void> = Promise.resolve();
  app.define(def('leaf'), {
    handle: async () => {
      await gate;
      return { kind: 'completed', output: 'leaf' };
    },
  });
  app.define(
    def('parent', {
      capabilities: [
        { id: 'delegation', versionRange: '^1.0.0' },
        { id: 'notification', versionRange: '^1.0.0' },
      ],
    }),
    {
      handle: async (_inv, ctx) => {
        await ctx.capabilities.invoke(
          'delegation',
          'delegate',
          { target: { instanceId: target }, input: {} },
          { stepKey: 'child' },
        );
        return { kind: 'completed', output: 'parent' };
      },
    },
  );
  const instance = async (id: string, key: string) =>
    (
      await app.createInstance(
        {
          definition: { id, version: '1.0.0' },
          ownerId: 'alice',
          idempotencyKey: key,
        },
        alice,
      )
    ).id;
  return {
    app,
    pdp,
    audit,
    instance,
    setTarget: (id: string) => (target = id),
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return release;
    },
  };
}

describe('D-15: agent identities, grant narrowing and the audit chain', () => {
  it('a child task runs under a grant narrowed to its target agent, and the audit records the chain', async () => {
    const grants = new NarrowingGrants();
    const s = delegationSetup({ grants });
    const leaf = await s.instance('leaf', 'l');
    s.setTarget(leaf);
    const parent = await s.instance('parent', 'p');
    const withGrant: TrustedPrincipal = {
      ...alice,
      delegatedAuthorityRef: 'g-root',
    };
    const t = await s.app.delegate(
      {
        target: { instanceId: parent },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'k',
      },
      withGrant,
    );
    await s.app.runUntilIdle();
    expect(await s.app.getResult(t.taskId, alice)).toBe('parent');
    expect(grants.narrowed).toEqual([
      { from: 'g-root', to: `g-root>${leaf}`, agentInstanceId: leaf },
    ]);
    const childTask = (await s.app.listTasks({ instanceId: leaf }, alice))
      .tasks[0]!;
    const stored = await s.app.store.transaction((tx) =>
      tx.get<{ grantRef: string; callerId: string; callerType: string }>(
        'tasks',
        childTask.taskId,
      ),
    );
    // The child is delegated by the parent agent's own identity, not by alice.
    expect(stored!.value).toMatchObject({
      grantRef: `g-root>${leaf}`,
      callerId: parent,
      callerType: 'agent',
    });
    const accepts = await s.app.auditLog.query(
      { tenantId: 't-1', type: 'task.accept' },
      auditor,
    );
    expect(accepts.map((e) => e.details)).toEqual([
      expect.objectContaining({ callerType: 'user', narrowed: false }),
      expect.objectContaining({
        callerType: 'agent',
        parentTaskId: t.taskId,
        narrowed: true,
      }),
    ]);
  });

  it('a refused narrowing denies the child delegation instead of widening authority', async () => {
    const grants = new NarrowingGrants();
    grants.refuse = true;
    const s = delegationSetup({ grants });
    s.setTarget(await s.instance('leaf', 'l'));
    const parent = await s.instance('parent', 'p');
    const t = await s.app.delegate(
      {
        target: { instanceId: parent },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'k',
      },
      { ...alice, delegatedAuthorityRef: 'g-root' },
    );
    await s.app.runUntilIdle();
    expect((await s.app.getTask(t.taskId, alice)).outcome?.code).toBe(
      'PermissionDenied',
    );
  });
});

describe('D-18: one PEP for every ingress path', () => {
  it('direct calls, the activation ingress and agent-originated delegation hit the same policy action and the same denial', async () => {
    const s = delegationSetup();
    const leaf = await s.instance('leaf', 'l');
    s.setTarget(leaf);
    const parent = await s.instance('parent', 'p');
    (s.pdp as FakePolicy).denied.add('delegation:delegate');
    expect(
      await code(
        s.app.delegate(
          {
            target: { instanceId: leaf },
            input: {},
            idempotencyKey: 'd',
            correlationId: 'd',
          },
          alice,
        ),
      ),
    ).toBe('PermissionDenied');
    const viaIngress = await createActivationIngress(s.app).receive(
      {
        schemaVersion: 1,
        kind: 'command',
        name: 'agent.delegate',
        messageId: 'm',
        correlationId: 'm',
        idempotencyKey: 'm',
        tenantId: 't-1',
        actor: { principalId: 'alice', principalType: 'user' },
        createdAt: '2026-11-05T00:00:00.000Z',
        payload: { target: { instanceId: leaf }, input: {} },
      },
      alice,
    );
    expect(viaIngress).toMatchObject({
      status: 'rejected',
      error: { code: 'PermissionDenied' },
    });
    // Let the parent itself be accepted, then deny its agent-originated child delegation.
    (s.pdp as FakePolicy).denied.clear();
    const t = await s.app.delegate(
      {
        target: { instanceId: parent },
        input: {},
        idempotencyKey: 'p',
        correlationId: 'p',
      },
      alice,
    );
    (s.pdp as FakePolicy).denied.add('delegation:delegate');
    await s.app.runUntilIdle();
    expect((await s.app.getTask(t.taskId, alice)).outcome?.code).toBe(
      'PermissionDenied',
    );
    const actions = (s.pdp as FakePolicy).requests
      .filter((r) => r.action === 'delegation:delegate')
      .map((r) => r.principal.type);
    expect(actions).toEqual(['user', 'user', 'user', 'agent']);
  });
});

describe('D-19: decision cache scope, expiry and revocation freshness', () => {
  const req = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({
    principal: alice,
    action: 'tool:x:call',
    resource: { type: 'capability', id: 'tool-use', tenantId: 't-1' },
    ...over,
  });

  it('reuses an allow within the TTL, re-asks after it, and never shares across principals, tenants or grants', async () => {
    const inner = new FakePolicy();
    const clock = new FakeClock('2026-11-05T00:00:00.000Z');
    const pdp = new CachingPolicyDecisionPoint(inner, {
      ttlMs: 1_000,
      now: clock.iso,
    });
    await pdp.decide(req());
    await pdp.decide(req());
    expect(inner.requests).toHaveLength(1);
    await pdp.decide(req({ principal: { ...alice, id: 'bob' } }));
    await pdp.decide(
      req({ principal: { ...alice, delegatedAuthorityRef: 'g' } }),
    );
    await pdp.decide(
      req({
        resource: { type: 'capability', id: 'tool-use', tenantId: 't-2' },
      }),
    );
    await pdp.decide(req({ context: { amount: 5 } }));
    await pdp.decide(req({ context: { amount: 5 } }));
    expect(inner.requests).toHaveLength(6);
    clock.advanceBy(1_001);
    await pdp.decide(req());
    expect(inner.requests).toHaveLength(7);
  });

  it('never caches failures or denies (by default); invalidate and a new policy version take effect at once', async () => {
    const inner = new FakePolicy();
    const pdp = new CachingPolicyDecisionPoint(inner, { ttlMs: 60_000 });
    inner.down = true;
    expect(await code(pdp.decide(req()))).not.toBe('no-error');
    inner.down = false;
    inner.denied.add('tool:x:call');
    expect((await pdp.decide(req())).effect).toBe('deny');
    inner.denied.clear();
    expect((await pdp.decide(req())).effect).toBe('allow');
    expect(pdp.size).toBe(1);
    // Revocation freshness: the grant's revocation drops the cached allow immediately.
    await pdp.decide(
      req({ principal: { ...alice, delegatedAuthorityRef: 'g-1' } }),
    );
    expect(pdp.invalidate({ grantRef: 'g-1' })).toBe(1);
    inner.denied.add('tool:x:call');
    expect(
      (
        await pdp.decide(
          req({ principal: { ...alice, delegatedAuthorityRef: 'g-1' } }),
        )
      ).effect,
    ).toBe('deny');
    inner.denied.clear();
    // A different policy version invalidates everything cached under the previous one.
    let version = 'v1';
    const versioned = new CachingPolicyDecisionPoint({
      decide: async () => ({ effect: 'allow', policyVersion: version }),
    });
    await versioned.decide(req());
    await versioned.decide(req({ action: 'other' }));
    expect(versioned.size).toBe(2);
    version = 'v2';
    await versioned.decide(req({ action: 'third' }));
    expect(versioned.size).toBe(1);
  });
});

describe('D-20: revocation checkpoint for running work', () => {
  it('revoking a grant signals running executions, holds the task behind the gate and keeps committed effects for compensation', async () => {
    const grants = new NarrowingGrants();
    const s = delegationSetup({ grants });
    const ops: TrustedPrincipal = {
      id: 'ops',
      type: 'service',
      tenantId: 't-1',
    };
    let signalled = false;
    s.app.define(
      def('worker', {
        capabilities: [{ id: 'notification', versionRange: '^1.0.0' }],
      }),
      {
        handle: async (_inv, ctx) => {
          await ctx.capabilities.invoke(
            'notification',
            'notify',
            { severity: 'normal', title: 'step 1 done', body: 'b' },
            { stepKey: 'step-1' },
          );
          // First run only: block until the revocation signal (a resumed run continues straight on).
          if (!signalled)
            await new Promise<void>((resolve) =>
              ctx.signal.addEventListener('abort', () => {
                signalled = true;
                resolve();
              }),
            );
          if (ctx.signal.aborted) throw ctx.signal.reason;
          await ctx.capabilities.invoke(
            'notification',
            'notify',
            { severity: 'normal', title: 'step 2 done', body: 'b' },
            { stepKey: 'step-2' },
          );
          return { kind: 'completed', output: 'done' };
        },
      },
    );
    const w = await s.instance('worker', 'w');
    const t = await s.app.delegate(
      {
        target: { instanceId: w },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'k',
      },
      { ...alice, delegatedAuthorityRef: 'g-1' },
    );
    await s.app.runtime.tick();
    await vi.waitFor(async () =>
      expect(await s.app.listEffects(t.taskId, alice)).toHaveLength(1),
    );
    expect(await code(s.app.revokeAuthority('g-1', alice))).toBe(
      'PermissionDenied',
    );
    grants.status.set('g-1', 'revoked');
    const r = await s.app.revokeAuthority('g-1', ops);
    expect(r.signalled).toEqual([t.taskId]);
    await s.app.runtime.idle();
    await s.app.runUntilIdle();
    expect(signalled).toBe(true);
    const snap = await s.app.getTask(t.taskId, alice);
    expect(snap.status).toBe('assigned');
    expect(
      (
        await s.app.store.transaction((tx) =>
          tx.get<{ reason: string }>('gates', t.taskId),
        )
      )?.value.reason,
    ).toBe('authority-revoked');
    // Committed effect stays committed and is visible for compensation; step 2 never ran.
    expect(
      (await s.app.listEffects(t.taskId, alice)).map((e) => e.stepKey),
    ).toEqual(['step-1']);
    const revocations = await s.app.auditLog.query(
      { tenantId: 't-1', type: 'authority.revoke' },
      auditor,
    );
    expect(revocations).toHaveLength(1);
    expect(JSON.stringify(revocations)).not.toContain('g-1');
    // A new grant and reauthorization resume without repeating step 1.
    await s.app.reauthorize(t.taskId, {
      ...alice,
      delegatedAuthorityRef: 'g-2',
    });
    await s.app.runUntilIdle();
    expect(await s.app.getResult(t.taskId, alice)).toBe('done');
    expect(
      (await s.app.listEffects(t.taskId, alice)).map((e) => e.stepKey),
    ).toEqual(['step-1', 'step-2']);
    expect(await code(s.app.listEffects(t.taskId, mallory))).toBe('NotFound');
  });
});
