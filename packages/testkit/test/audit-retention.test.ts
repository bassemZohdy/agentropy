// FEAT-028.4: audit lifecycle (M3-04, D-21, D-22, ADR-0022) — independent permissions with audited denials,
// retention floors, legal hold, prefix disposal with non-sensitive receipts, external anchors that catch
// truncation and wholesale rewriting, and offline-verifiable exports.
import {
  BUILTIN_PROFILES,
  digestOf,
  type AgentDefinition,
  type AuditEvent,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  createLocalApp,
  verifyAuditChain,
  type AuditAnchor,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeAudit, FakeClock, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const auditor: TrustedPrincipal = { id: 'aud', type: 'user', tenantId: 't-1' };
const other: TrustedPrincipal = { id: 'eve', type: 'user', tenantId: 't-2' };
const DAY = 86_400_000;

const def: AgentDefinition = {
  id: 'echo',
  version: '1.0.0',
  displayName: 'echo',
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'echo', version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
};

async function setup() {
  const clock = new FakeClock('2026-01-01T00:00:00.000Z');
  const pdp = new FakePolicy();
  const sink = new FakeAudit();
  const anchors: AuditAnchor[] = [];
  const store = sqliteTempStore();
  const app = createLocalApp({
    store,
    pdp,
    audit: sink,
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
    auditRetention: { defaultDays: 30, floorDays: 7 },
    auditAnchors: { publish: async (a) => void anchors.push(a) },
  });
  app.define(def, {
    handle: async (inv) => ({ kind: 'completed', output: inv.input }),
  });
  const inst = await app.createInstance(
    {
      definition: { id: 'echo', version: '1.0.0' },
      ownerId: 'alice',
      idempotencyKey: 'i',
    },
    alice,
  );
  let n = 0;
  const activity = async (count = 2) => {
    for (let i = 0; i < count; i++) {
      const k = `k${n++}`;
      await app.delegate(
        {
          target: { instanceId: inst.id },
          input: {},
          idempotencyKey: k,
          correlationId: k,
        },
        alice,
      );
    }
    await app.runUntilIdle();
  };
  const rows = () =>
    store.transaction((tx) =>
      tx.find<{
        auditId: string;
        type: string;
        event: AuditEvent;
        prevHash: string;
        hash: string;
      }>('audit', { where: { tenantId: 't-1' }, orderBy: 'seq' }),
    );
  return { app, clock, pdp, sink, anchors, store, activity, rows };
}

describe('audit permissions (ADR-0022 §1–3)', () => {
  it('each lifecycle action needs its own permission; denials and uses are audited; other tenants see nothing', async () => {
    const s = await setup();
    await s.activity();
    s.pdp.denied.add('audit:dispose');
    expect(await code(s.app.auditLog.dispose('t-1', auditor))).toBe(
      'PermissionDenied',
    );
    await s.app.auditLog.query({ tenantId: 't-1' }, auditor);
    expect(await code(s.app.auditLog.exportLog('t-1', other))).toBe('NotFound');
    expect(
      await code(
        s.app.auditLog.placeHold('t-1', { holdId: 'h', reason: 'x' }, other),
      ),
    ).toBe('NotFound');
    const types = (await s.rows()).map((r) => [
      r.value.type,
      r.value.event.decision,
    ]);
    expect(types).toContainEqual(['audit.dispose', 'deny']);
    expect(types).toContainEqual(['audit.read', 'allow']);
  });

  it('a tenant can lengthen retention but never go below the deployment floor', async () => {
    const s = await setup();
    expect(
      await code(s.app.auditLog.setRetention('t-1', { days: 3 }, auditor)),
    ).toBe('SchemaViolation');
    expect(
      await code(
        s.app.auditLog.setRetention(
          't-1',
          { days: 60, perType: { 'task.accept': 1 } },
          auditor,
        ),
      ),
    ).toBe('SchemaViolation');
    await s.app.auditLog.setRetention('t-1', { days: 60 }, auditor);
    await s.activity();
    s.clock.advanceBy(40 * DAY);
    expect(await s.app.auditLog.dispose('t-1', auditor)).toBeUndefined();
    s.clock.advanceBy(30 * DAY);
    expect(await s.app.auditLog.dispose('t-1', auditor)).toBeDefined();
  });
});

describe('retention, disposal and legal hold (ADR-0022 §4–6)', () => {
  it('disposes the expired, forwarded prefix and keeps a receipt that links the rest of the chain', async () => {
    const s = await setup();
    await s.activity(3);
    const before = (await s.rows()).length;
    s.clock.advanceBy(31 * DAY);
    await s.activity(1);
    const receipt = (await s.app.auditLog.dispose('t-1', auditor))!;
    expect(receipt.fromPosition).toBe(1);
    expect(receipt.toPosition).toBe(before);
    expect(receipt.countByType['task.accept']).toBe(3);
    expect(JSON.stringify(receipt)).not.toContain('correlationId');
    const after = await s.rows();
    expect(
      after.every((r) => r.value.event.at >= '2026-02-01T00:00:00.000Z'),
    ).toBe(true);
    expect(await s.app.auditLog.verify('t-1', auditor)).toMatchObject({
      ok: true,
      disposed: before,
    });
  });

  it('never disposes rows the audit sink has not received', async () => {
    const s = await setup();
    s.sink.failing = true;
    await s.activity();
    s.clock.advanceBy(31 * DAY);
    expect(await s.app.auditLog.dispose('t-1', auditor)).toBeUndefined();
  });

  it('a legal hold blocks disposal of matching rows until an authorized release; release deletes nothing', async () => {
    const s = await setup();
    await s.activity();
    await s.app.auditLog.placeHold(
      't-1',
      { holdId: 'case-7', reason: 'investigation', types: ['task.accept'] },
      auditor,
    );
    s.clock.advanceBy(31 * DAY);
    await s.app.runUntilIdle();
    const held = await s.app.auditLog.dispose('t-1', auditor);
    // Disposal stops at the first held row: only rows before it may go.
    const remaining = (await s.rows()).map((r) => r.value.type);
    expect(remaining).toContain('task.accept');
    expect(held?.countByType['task.accept'] ?? 0).toBe(0);

    s.pdp.denied.add('audit:release-hold');
    expect(
      await code(s.app.auditLog.releaseHold('t-1', 'case-7', auditor)),
    ).toBe('PermissionDenied');
    s.pdp.denied.clear();
    const countBefore = (await s.rows()).length;
    const released = await s.app.auditLog.releaseHold('t-1', 'case-7', auditor);
    expect(released.status).toBe('released');
    expect((await s.rows()).length).toBe(countBefore + 1); // only the release event was added
    await s.app.runUntilIdle();
    const receipt = await s.app.auditLog.dispose('t-1', auditor);
    expect(receipt?.countByType['task.accept']).toBe(2);
  });
});

describe('integrity anchors and archive (ADR-0022 §7)', () => {
  /** An attacker with database access rewrites one decision and recomputes every later hash. */
  async function rewriteChain(s: Awaited<ReturnType<typeof setup>>) {
    const rows = await s.rows();
    await s.store.transaction(async (tx) => {
      let prev = 'sha256:genesis';
      for (const [i, r] of rows.entries()) {
        const event =
          i === 0
            ? { ...r.value.event, decision: 'deny' as const }
            : r.value.event;
        const hash = digestOf({
          prevHash: prev,
          auditId: r.value.auditId,
          event,
        });
        await tx.update('audit', r.id, r.revision, {
          ...r.value,
          event,
          prevHash: prev,
          hash,
        });
        prev = hash;
      }
    });
  }

  it('a consistent rewrite passes the bare chain check but fails against a published anchor', async () => {
    const s = await setup();
    await s.activity();
    const anchor = await s.app.auditLog.anchor('t-1', auditor);
    expect(s.anchors).toEqual([anchor]);
    await rewriteChain(s);
    expect(await s.app.auditLog.verify('t-1', auditor)).toMatchObject({
      ok: true,
    });
    expect(
      await s.app.auditLog.verify('t-1', auditor, { anchors: s.anchors }),
    ).toMatchObject({ ok: false, reason: 'anchor-mismatch' });
  });

  it('deleting the newest rows is caught as truncation', async () => {
    const s = await setup();
    await s.activity();
    await s.app.auditLog.anchor('t-1', auditor);
    const rows = await s.rows();
    await s.store.transaction(async (tx) => {
      for (const r of rows.slice(-2))
        await tx.remove('audit', r.id, r.revision);
    });
    expect(
      await s.app.auditLog.verify('t-1', auditor, { anchors: s.anchors }),
    ).toMatchObject({ ok: false, reason: 'truncated' });
  });

  it('anchors stay valid across an authorized disposal', async () => {
    const s = await setup();
    await s.activity();
    await s.app.auditLog.anchor('t-1', auditor);
    s.clock.advanceBy(31 * DAY);
    await s.activity(1);
    await s.app.auditLog.anchor('t-1', auditor);
    await s.app.runUntilIdle();
    expect(await s.app.auditLog.dispose('t-1', auditor)).toBeDefined();
    expect(
      await s.app.auditLog.verify('t-1', auditor, { anchors: s.anchors }),
    ).toMatchObject({ ok: true });
  });

  it('an export verifies offline; a tampered export does not', async () => {
    const s = await setup();
    await s.activity();
    const bundle = await s.app.auditLog.exportLog('t-1', auditor);
    expect(verifyAuditChain(bundle.rows, bundle.startHash)).toEqual({
      ok: true,
    });
    bundle.rows[1]!.event = { ...bundle.rows[1]!.event, principalId: 'x' };
    expect(verifyAuditChain(bundle.rows, bundle.startHash)).toEqual({
      ok: false,
      brokenAt: bundle.rows[1]!.auditId,
    });
  });
});
