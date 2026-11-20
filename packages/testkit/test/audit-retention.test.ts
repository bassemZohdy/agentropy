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

describe('a retention job disposing while a paged read runs (FIX-082)', () => {
  /**
   * A service on a store where another worker disposes up to `maxRows` rows (through the real service) right after
   * a page of the chain was read, before the reader's next transaction: after the first page of every pass over the
   * chain (`every: false`, a retention job that outlasts any bounded number of re-reads), or after every page
   * (`every: true`, one that overtakes the reader again and again). A page read is the `afterSeq` find on `audit`.
   * The log has 150 expired rows, with an anchor published at position 41, and a few recent ones.
   */
  async function underRetentionJob(o: { maxRows: number; every: boolean }) {
    const s = await setup();
    await s.activity(40);
    const anchor = await s.app.auditLog.anchor('t-1', auditor);
    await s.activity(110);
    s.clock.advanceBy(31 * DAY);
    await s.activity(2);
    let armed = false;
    let on = false;
    const disposals: number[] = [];
    const store: Store = {
      durability: s.store.durability,
      close: () => s.store.close(),
      transaction: async (fn) => {
        if (on && armed) {
          armed = false;
          const receipt = await s.app.auditLog.dispose('t-1', auditor, {
            maxRows: o.maxRows,
          });
          if (receipt) disposals.push(receipt.toPosition);
        }
        let paged = false;
        const out = await s.store.transaction((tx) =>
          fn({
            get: (c, id) => tx.get(c, id),
            insert: (c, id, v) => tx.insert(c, id, v),
            update: (c, id, r, v) => tx.update(c, id, r, v),
            remove: (c, id, r) => tx.remove(c, id, r),
            find: (c, f) => {
              if (
                c === 'audit' &&
                f?.afterSeq !== undefined &&
                (o.every || f.afterSeq === 0)
              )
                paged = true;
              return tx.find(c, f);
            },
          } as StoreTx),
        );
        if (paged) armed = true;
        return out;
      },
    };
    const service = new AuditService({
      store,
      pdp: s.pdp,
      now: s.clock.iso,
      retention: { defaultDays: 30, floorDays: 7 },
      pageSize: 5,
    });
    const run = async <T>(read: () => Promise<T>): Promise<T> => {
      on = true;
      try {
        return await read();
      } finally {
        on = false;
      }
    };
    const verifyEvents = async () =>
      (await s.rows())
        .filter((r) => r.value.type === 'audit.verify')
        .map((r) => r.value.event.details);
    return { s, service, anchor, disposals, run, verifyEvents };
  }

  it('FIX-082: verify reports a sound chain as sound, and records it so, when a disposal follows every re-read', async () => {
    const t = await underRetentionJob({ maxRows: 8, every: false });
    const result = await t.run(() =>
      t.service.verify('t-1', auditor, { anchors: [t.anchor] }),
    );
    expect(t.disposals.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: true });
    expect(await t.verifyEvents()).toEqual([
      expect.objectContaining({ ok: true }),
    ]);
  });

  it('FIX-082: verify stays sound while disposals overtake the reader page after page', async () => {
    const t = await underRetentionJob({ maxRows: 8, every: true });
    const before = (await t.s.rows()).length;
    const result = await t.run(() =>
      t.service.verify('t-1', auditor, { anchors: [t.anchor] }),
    );
    expect(t.disposals.length).toBeGreaterThan(3); // more than any bounded re-read would outlast
    expect((await t.s.rows()).length).toBeLessThan(before);
    expect(result).toMatchObject({ ok: true });
    expect(await t.verifyEvents()).toEqual([
      expect.objectContaining({ ok: true }),
    ]);
    // A quiet verify afterwards agrees; disposed rows are counted once, as disposed.
    const quiet = await t.service.verify('t-1', auditor, {
      anchors: [t.anchor],
    });
    expect(quiet).toMatchObject({ ok: true });
    if (result.ok && quiet.ok) {
      expect(result.disposed).toBe(t.disposals.at(-1));
      expect(quiet.disposed).toBeGreaterThanOrEqual(result.disposed);
      expect(quiet.count + quiet.disposed).toBeGreaterThan(
        result.count + result.disposed,
      ); // the rows the read and its disposals appended since
    }
  });

  it('FIX-082: an anchor at a position a disposal removed before the reader got there is not reported as truncation', async () => {
    // A disposal of 45 rows after the first 5-row page removes the anchored row (position 41) unread.
    const t = await underRetentionJob({ maxRows: 45, every: false });
    expect(t.anchor.position).toBeGreaterThan(5);
    expect(t.anchor.position).toBeLessThanOrEqual(45);
    const result = await t.run(() =>
      t.service.verify('t-1', auditor, { anchors: [t.anchor] }),
    );
    expect(t.disposals[0]).toBe(45);
    expect(result).toMatchObject({ ok: true });
  });

  it('FIX-082: an export taken while disposals overtake it is a chain that verifies offline', async () => {
    for (const every of [false, true]) {
      const t = await underRetentionJob({ maxRows: 8, every });
      const bundle = await t.run(() => t.service.exportLog('t-1', auditor));
      expect(t.disposals.length).toBeGreaterThan(0);
      expect(verifyAuditChain(bundle.rows, bundle.startHash)).toEqual({
        ok: true,
      });
      // It starts right after the newest receipt it saw.
      expect(bundle.startPosition).toBe(t.disposals.at(-1)! + 1);
      expect(bundle.rows.length).toBeGreaterThan(0);
    }
  });

  it('FIX-082: a rewritten row is still reported while disposals run', async () => {
    for (const every of [false, true]) {
      const t = await underRetentionJob({ maxRows: 8, every });
      const rows = await t.s.rows();
      // The oldest row that has not expired: no disposal removes it, and every disposal ends right before it.
      const now = Date.parse(t.s.clock.iso());
      const victim = rows.find((r) => Date.parse(r.value.event.at) >= now)!;
      await t.s.store.transaction((tx) =>
        tx.update('audit', victim.id, victim.revision, {
          ...victim.value,
          event: { ...victim.value.event, decision: 'deny' },
        }),
      );
      const result = await t.run(() => t.service.verify('t-1', auditor));
      expect(t.disposals.length).toBeGreaterThan(0);
      expect(result).toMatchObject({
        ok: false,
        brokenAt: victim.value.auditId,
      });
    }
  });

  it('FIX-082: disposals that end behind the reader, at rows it already checked, keep verify and export sound', async () => {
    // 3-row disposals after every 5-row page end behind the reader's cursor, at a row it has checked.
    for (const read of ['verify', 'export'] as const) {
      const t = await underRetentionJob({ maxRows: 3, every: true });
      if (read === 'verify') {
        const result = await t.run(() =>
          t.service.verify('t-1', auditor, { anchors: [t.anchor] }),
        );
        expect(result).toMatchObject({ ok: true });
      } else {
        const bundle = await t.run(() => t.service.exportLog('t-1', auditor));
        expect(verifyAuditChain(bundle.rows, bundle.startHash)).toEqual({
          ok: true,
        });
        expect(bundle.startPosition).toBeGreaterThan(1);
      }
      expect(t.disposals.length).toBeGreaterThan(3);
    }
  });

  /**
   * A 5-row-page service on a store where someone with write access to it changes the log (`tamper`, through the
   * store, not the service) once, right after the reader's `afterPages`-th page and before its next transaction.
   * With `dispose`, a legitimate disposal of that many rows (through the real service) follows the change.
   */
  async function tamperedAfterPages(
    s: Awaited<ReturnType<typeof setup>>,
    afterPages: number,
    tamper: (tx: StoreTx) => Promise<void>,
    o: { checkWindow?: number; dispose?: number } = {},
  ) {
    let pages = 0;
    let pending = false;
    const store: Store = {
      durability: s.store.durability,
      close: () => s.store.close(),
      transaction: async (fn) => {
        if (pending) {
          pending = false;
          await s.store.transaction(tamper);
          if (o.dispose)
            expect(
              await s.app.auditLog.dispose('t-1', auditor, {
                maxRows: o.dispose,
              }),
            ).toMatchObject({ toPosition: o.dispose });
        }
        let paged = false;
        const out = await s.store.transaction((tx) =>
          fn({
            get: (c, id) => tx.get(c, id),
            insert: (c, id, v) => tx.insert(c, id, v),
            update: (c, id, r, v) => tx.update(c, id, r, v),
            remove: (c, id, r) => tx.remove(c, id, r),
            find: (c, f) => {
              if (c === 'audit' && f?.afterSeq !== undefined) paged = true;
              return tx.find(c, f);
            },
          } as StoreTx),
        );
        if (paged && ++pages === afterPages) pending = true;
        return out;
      },
    };
    return new AuditService({
      store,
      pdp: s.pdp,
      now: s.clock.iso,
      retention: { defaultDays: 30, floorDays: 7 },
      pageSize: 5,
      ...(o.checkWindow ? { checkWindow: o.checkWindow } : {}),
    });
  }

  /** A receipt nobody's disposal wrote: rows 1..toPosition, from genesis to `lastHash`. */
  const forgedReceipt = (toPosition: number, lastHash: string) => ({
    receiptId: 'forged',
    tenantId: 't-1',
    fromPosition: 1,
    toPosition,
    startHash: 'sha256:genesis',
    lastHash,
    countByType: {},
    oldestAt: '2026-01-01T00:00:00.000Z',
    newestAt: '2026-01-01T00:00:00.000Z',
    authorizedBy: 'mallory',
    at: '2026-01-01T00:00:00.000Z',
  });

  it('FIX-082: an export refuses a receipt read mid-export that no disposal backs', async () => {
    const s = await setup();
    await s.activity(11);
    const rows = await s.rows();
    expect(rows.length).toBeGreaterThanOrEqual(12);
    // After the first page, a receipt claims rows 1..5 were disposed; none was removed.
    const service = await tamperedAfterPages(s, 1, (tx) =>
      tx.insert(
        'auditReceipts',
        'forged',
        forgedReceipt(5, rows[4]!.value.hash),
      ),
    );
    expect(await code(service.exportLog('t-1', auditor))).toBe('InvalidState');
    const exported = (await s.rows())
      .filter((r) => r.value.type === 'audit.export')
      .map((r) => r.value.event.details);
    expect(exported).toEqual([
      expect.objectContaining({ ok: false, brokenAt: rows[0]!.value.auditId }),
    ]);
  });

  it('FIX-082: an export refuses a receipt read mid-export whose last hash is not the row it holds there', async () => {
    const s = await setup();
    await s.activity(11);
    const rows = await s.rows();
    // After two pages, rows 1..7 go and a receipt says 1..5, ending at row 7's hash.
    const service = await tamperedAfterPages(s, 2, async (tx) => {
      for (const r of rows.slice(0, 7))
        await tx.remove('audit', r.id, r.revision);
      await tx.insert(
        'auditReceipts',
        'forged',
        forgedReceipt(5, rows[6]!.value.hash),
      );
    });
    expect(await code(service.exportLog('t-1', auditor))).toBe('InvalidState');
  });

  it('FIX-082: verify reports a receipt read mid-read that understates the disposal behind the reader', async () => {
    const s = await setup();
    await s.activity(14);
    const rows = await s.rows();
    expect(rows.length).toBeGreaterThanOrEqual(15);
    const at = rows[11]!.value;
    const anchors: AuditAnchor[] = [
      {
        tenantId: 't-1',
        position: 12,
        auditId: at.auditId,
        hash: at.hash,
        at: s.clock.iso(),
      },
    ];
    // After two pages (rows 1..10 checked), rows 1..7 go and a receipt says 1..5, ending at row 7's hash.
    const service = await tamperedAfterPages(s, 2, async (tx) => {
      for (const r of rows.slice(0, 7))
        await tx.remove('audit', r.id, r.revision);
      await tx.insert(
        'auditReceipts',
        'forged',
        forgedReceipt(5, rows[6]!.value.hash),
      );
    });
    expect(await service.verify('t-1', auditor, { anchors })).toMatchObject({
      ok: false,
      brokenAt: 'forged',
      reason: 'receipt-chain',
    });
    // A fresh read reports it too.
    expect(await service.verify('t-1', auditor, { anchors })).toMatchObject({
      ok: false,
    });
  });

  it('FIX-082: a receipt read mid-export is refused when the oldest row was relinked to it but not disposed', async () => {
    const s = await setup();
    await s.activity(11);
    const rows = await s.rows();
    // After the first page: a receipt for rows 1..5, none removed, and row 1 relinked to the receipt's last hash.
    const service = await tamperedAfterPages(s, 1, async (tx) => {
      await tx.insert(
        'auditReceipts',
        'forged',
        forgedReceipt(5, rows[4]!.value.hash),
      );
      await tx.update('audit', rows[0]!.id, rows[0]!.revision, {
        ...rows[0]!.value,
        prevHash: rows[4]!.value.hash,
      });
    });
    expect(await code(service.exportLog('t-1', auditor))).toBe('InvalidState');
  });

  it('FIX-082: verify reports a receipt read mid-read when the oldest row left is not the one after it', async () => {
    const s = await setup();
    await s.activity(14);
    const rows = await s.rows();
    // After two pages: rows 1..7 go, a receipt says 1..5 (row 5's hash), and row 8 is relinked to that hash.
    const service = await tamperedAfterPages(s, 2, async (tx) => {
      for (const r of rows.slice(0, 7))
        await tx.remove('audit', r.id, r.revision);
      await tx.insert(
        'auditReceipts',
        'forged',
        forgedReceipt(5, rows[4]!.value.hash),
      );
      await tx.update('audit', rows[7]!.id, rows[7]!.revision, {
        ...rows[7]!.value,
        prevHash: rows[4]!.value.hash,
      });
    });
    expect(await service.verify('t-1', auditor)).toMatchObject({
      ok: false,
      brokenAt: rows[7]!.value.auditId,
    });
    // A fresh read reports the same row.
    expect(await service.verify('t-1', auditor)).toMatchObject({
      ok: false,
      brokenAt: rows[7]!.value.auditId,
    });
  });

  it('FIX-082: a receipt that ends behind the check window fails the read with a retryable error, inside it is checked', async () => {
    // Expired rows; after two 5-row pages (rows 1..10 checked) a legitimate disposal removes rows 1..N.
    const expired = async () => {
      const s = await setup();
      await s.activity(14);
      s.clock.advanceBy(31 * DAY);
      await s.activity(2);
      return s;
    };
    const noChange = async () => undefined;
    const events = async (s: Awaited<ReturnType<typeof setup>>) =>
      (await s.rows())
        .map((r) => r.value.type)
        .filter((t) => t === 'audit.verify' || t === 'audit.export');
    // A window of 3 holds rows 8..10: a disposal of rows 1..5 ends at a row the reader can no longer compare.
    for (const read of ['verify', 'export'] as const) {
      const s = await expired();
      const service = await tamperedAfterPages(s, 2, noChange, {
        checkWindow: 3,
        dispose: 5,
      });
      const err = await (
        read === 'verify'
          ? service.verify('t-1', auditor)
          : service.exportLog('t-1', auditor)
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 'StaleRevision',
        retryable: true,
        details: { reason: 'checkWindow', position: 5, window: 3 },
      });
      expect(await events(s)).toEqual([]); // neither a sound nor a tampered result is recorded
      // Read again, it is sound.
      expect(await service.verify('t-1', auditor)).toMatchObject({ ok: true });
    }
    // A disposal of rows 1..8 ends inside the window: checked, and sound.
    for (const read of ['verify', 'export'] as const) {
      const s = await expired();
      const service = await tamperedAfterPages(s, 2, noChange, {
        checkWindow: 3,
        dispose: 8,
      });
      if (read === 'verify')
        expect(await service.verify('t-1', auditor)).toMatchObject({
          ok: true,
          disposed: 8,
        });
      else {
        const bundle = await service.exportLog('t-1', auditor);
        expect(bundle.startPosition).toBe(9);
        expect(verifyAuditChain(bundle.rows, bundle.startHash)).toEqual({
          ok: true,
        });
      }
    }
  });
});
