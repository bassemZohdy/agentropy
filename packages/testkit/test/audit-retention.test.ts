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
import type { Store, StoreTx } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  AuditService,
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
  async function rewriteChain(
    s: Awaited<ReturnType<typeof setup>>,
    moveHead = true,
  ) {
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
      // An attacker with store access also moves the chain head, or the next append would expose the rewrite.
      const head = await tx.get<{ auditId: string }>('auditHeads', 't-1');
      if (head && moveHead)
        await tx.update('auditHeads', 't-1', head.revision, {
          ...head.value,
          hash: prev,
        });
    });
  }

  it('a store written before chain heads existed links its next append to the scanned chain end', async () => {
    const s = await setup();
    await s.activity();
    await s.store.transaction(async (tx) => {
      const head = (await tx.get('auditHeads', 't-1'))!;
      await tx.remove('auditHeads', 't-1', head.revision);
    });
    await s.activity(1);
    expect(await s.app.auditLog.verify('t-1', auditor)).toMatchObject({
      ok: true,
    });
    expect(
      await s.store.transaction((tx) => tx.get('auditHeads', 't-1')),
    ).toBeDefined();
  });

  it('a rewrite that leaves the chain head alone breaks at the next append', async () => {
    const s = await setup();
    await s.activity();
    await rewriteChain(s, false);
    // The rewritten chain is self-consistent until the next append links to the real head.
    expect(await s.app.auditLog.verify('t-1', auditor)).toMatchObject({
      ok: true,
    });
    await s.activity(1);
    expect(await s.app.auditLog.verify('t-1', auditor)).toMatchObject({
      ok: false,
    });
  });

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

describe('audit work in pages (TASK-067)', () => {
  /** A service over the same store whose `find` calls on the audit log are counted and sized. */
  function paged(s: Awaited<ReturnType<typeof setup>>, pageSize = 5) {
    const stats = { rowsRead: 0, largest: 0 };
    const store: Store = {
      durability: s.store.durability,
      close: () => s.store.close(),
      transaction: (fn) =>
        s.store.transaction((tx) =>
          fn({
            ...tx,
            find: async (c, o) => {
              const rows = await tx.find(c, o);
              if (c === 'audit') {
                stats.rowsRead += rows.length;
                stats.largest = Math.max(stats.largest, rows.length);
              }
              return rows;
            },
            get: (c, id) => tx.get(c, id),
            insert: (c, id, v) => tx.insert(c, id, v),
            update: (c, id, r, v) => tx.update(c, id, r, v),
            remove: (c, id, r) => tx.remove(c, id, r),
          } as StoreTx),
        ),
    };
    const service = new AuditService({
      store,
      pdp: s.pdp,
      now: s.clock.iso,
      retention: { defaultDays: 30, floorDays: 7 },
      anchorSink: { publish: async (a) => void s.anchors.push(a) },
      pageSize,
    });
    return { service, stats };
  }

  it('TASK-067: anchor reads a bounded number of rows however long the log is', async () => {
    const s = await setup();
    await s.activity(20);
    const { service, stats } = paged(s);
    const total = (await s.rows()).length;
    expect(total).toBeGreaterThan(15);
    const a = await service.anchor('t-1', auditor);
    expect(stats.rowsRead).toBeLessThanOrEqual(1);
    // The position and hash are those of the chain end, anchor event included.
    const rows = await s.rows();
    expect(a.position).toBe(rows.length);
    expect(a.auditId).toBe(rows.at(-1)!.value.auditId);
    expect(a.hash).toBe(rows.at(-1)!.value.hash);
  });

  it('TASK-067: dispose removes a long prefix in bounded transactions and verify still passes', async () => {
    const s = await setup();
    await s.activity(12);
    const before = (await s.rows()).length;
    s.clock.advanceBy(31 * DAY);
    await s.activity(1);
    await s.app.auditLog.anchor('t-1', auditor);
    const { service, stats } = paged(s, 7);
    const receipts: { fromPosition: number; toPosition: number }[] = [];
    for (let calls = 0; calls < 50; calls++) {
      const r = await service.dispose('t-1', auditor, { maxRows: 10 });
      if (!r) break;
      receipts.push(r);
    }
    expect(receipts.length).toBeGreaterThan(1);
    for (const r of receipts)
      expect(r.toPosition - r.fromPosition + 1).toBeLessThanOrEqual(10);
    expect(receipts.at(-1)!.toPosition).toBe(before);
    expect(stats.largest).toBeLessThanOrEqual(10);
    expect(
      await service.verify('t-1', auditor, { anchors: s.anchors }),
    ).toMatchObject({ ok: true, disposed: before });
  });

  it('TASK-067: a head written before it kept the position is counted once, on the next append', async () => {
    const s = await setup();
    await s.activity(3);
    const total = (await s.rows()).length;
    await s.store.transaction(async (tx) => {
      const head = (await tx.get<{ position?: number }>('auditHeads', 't-1'))!;
      const { position: _p, ...legacy } = head.value;
      void _p;
      await tx.update('auditHeads', 't-1', head.revision, legacy);
    });
    const { service, stats } = paged(s);
    // The anchor records its own event first, which counts the log once and writes the position back.
    const a = await service.anchor('t-1', auditor);
    expect(a.position).toBe(total + 1);
    expect(stats.rowsRead).toBeGreaterThan(0);
    stats.rowsRead = 0;
    const b = await service.anchor('t-1', auditor);
    expect(b.position).toBe(total + 2);
    expect(stats.rowsRead).toBe(0);
  });

  it('TASK-067: verify and export work in pages, and a rewritten row is still reported', async () => {
    const s = await setup();
    await s.activity(6);
    const { service, stats } = paged(s, 5);
    const total = (await s.rows()).length;
    expect(await service.verify('t-1', auditor)).toMatchObject({
      ok: true,
      count: expect.any(Number),
    });
    expect(stats.largest).toBeLessThanOrEqual(5);
    const bundle = await service.exportLog('t-1', auditor);
    expect(stats.largest).toBeLessThanOrEqual(5);
    expect(bundle.rows.length).toBeGreaterThanOrEqual(total);
    expect(verifyAuditChain(bundle.rows, bundle.startHash)).toEqual({
      ok: true,
    });
    // One row in the middle of the log is rewritten without touching the links.
    const rows = await s.rows();
    const victim = rows[Math.floor(rows.length / 2)]!;
    await s.store.transaction((tx) =>
      tx.update('audit', victim.id, victim.revision, {
        ...victim.value,
        event: { ...victim.value.event, decision: 'deny' },
      }),
    );
    expect(await service.verify('t-1', auditor)).toMatchObject({
      ok: false,
      brokenAt: victim.value.auditId,
    });
  });
});

describe('a disposal during a paged read (FIX-079)', () => {
  /** A service whose second transaction is preceded by a disposal committed through the real service. */
  async function withDisposalAfterFirstPage() {
    const s = await setup();
    await s.activity(6);
    s.clock.advanceBy(31 * DAY);
    await s.activity(2);
    let armed = false;
    let transactions = 0;
    const store: Store = {
      durability: s.store.durability,
      close: () => s.store.close(),
      transaction: async (fn) => {
        // The first page is read; then another worker disposes the expired prefix, rows past this reader's cursor too.
        if (armed && ++transactions === 2) {
          armed = false;
          expect(await s.app.auditLog.dispose('t-1', auditor)).toBeDefined();
        }
        return s.store.transaction(fn);
      },
    };
    const service = new AuditService({
      store,
      pdp: s.pdp,
      now: s.clock.iso,
      retention: { defaultDays: 30, floorDays: 7 },
      pageSize: 5,
    });
    return { s, service, arm: () => (armed = true) };
  }

  it('FIX-079: verify is not fooled by a disposal that commits between two pages', async () => {
    const { s, service, arm } = await withDisposalAfterFirstPage();
    const before = (await s.rows()).length;
    arm();
    const result = await service.verify('t-1', auditor);
    expect(result).toMatchObject({ ok: true });
    expect((await s.rows()).length).toBeLessThan(before); // the disposal did happen
    expect(await service.verify('t-1', auditor)).toMatchObject({ ok: true });
  });

  it('FIX-079: an export is a chain that verifies offline although a disposal committed while it was read', async () => {
    const { service, arm } = await withDisposalAfterFirstPage();
    arm();
    const bundle = await service.exportLog('t-1', auditor);
    expect(verifyAuditChain(bundle.rows, bundle.startHash)).toEqual({
      ok: true,
    });
    expect(bundle.startPosition).toBeGreaterThan(1); // it starts after the receipt the disposal wrote
  });
});
