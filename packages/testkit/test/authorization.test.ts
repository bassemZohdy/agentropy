// TASK-026.3 (part): SEC-06 credential rotation (D-17) and the SEC-05 M2 part — tenant-scoped audit access and
// hash-chain tamper evidence (D-21).
import {
  AgentropyError,
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type CredentialProvider,
  type ToolDescriptor,
  type ToolInvocationContext,
  type TrustedPrincipal,
} from '@agentropy/core';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DefaultToolExecutor,
  DirectToolProvider,
  InMemoryToolRegistry,
  ToolProviderRegistry,
  createLocalApp,
} from '../../runtime/src/index.js';
import { SqliteStore, code } from '../../runtime/test/harness.js';
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
