// FEAT-039.1: the audit forwarder reads what is still to be forwarded, not the whole audit log on every tick.
import type { Store, StoreTx } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { AuditForwarder } from '../src/index.js';
import { completes, harness, sqliteTempStore } from './harness.js';

/** Counts the audit documents each `find` hands back. */
function countingStore() {
  const inner = sqliteTempStore();
  const seen = { auditRowsRead: 0 };
  const store: Store = {
    durability: inner.durability,
    close: () => inner.close(),
    transaction: (fn) =>
      inner.transaction((tx) =>
        fn({
          ...tx,
          find: async (c, o) => {
            const rows = await tx.find(c, o);
            if (c === 'audit') seen.auditRowsRead += rows.length;
            return rows;
          },
          get: (c, id) => tx.get(c, id),
          insert: (c, id, v) => tx.insert(c, id, v),
          update: (c, id, r, v) => tx.update(c, id, r, v),
          remove: (c, id, r) => tx.remove(c, id, r),
        } as StoreTx),
      ),
  };
  return { store, seen };
}

describe('audit forwarding cost (FEAT-039.1)', () => {
  it('a drain reads only unforwarded rows: an idle tick over a long log reads none, new rows are forwarded in order', async () => {
    const { store, seen } = countingStore();
    const h = harness({ store });
    h.define('d', completes());
    const inst = await h.instance('d');
    for (let i = 0; i < 25; i++) await h.delegate(inst.id, {}, `k${i}`);
    const first = await h.forwarder.drain();
    expect(first).toBeGreaterThanOrEqual(25);
    expect(h.audit.events).toHaveLength(first);

    seen.auditRowsRead = 0;
    expect(await h.forwarder.drain()).toBe(0);
    expect(seen.auditRowsRead).toBe(0); // the log is long, nothing is pending

    await h.delegate(inst.id, {}, 'more');
    seen.auditRowsRead = 0;
    const next = await h.forwarder.drain();
    expect(next).toBeGreaterThanOrEqual(1);
    expect(seen.auditRowsRead).toBe(next); // exactly the new rows
    expect(h.audit.events).toHaveLength(first + next);
  });

  it('a failing sink stops the drain at the first row and retries it next time', async () => {
    const h = harness();
    h.define('d', completes());
    const inst = await h.instance('d');
    await h.delegate(inst.id, {}, 'k');
    h.audit.failing = true;
    expect(await h.forwarder.drain()).toBe(0);
    h.audit.failing = false;
    expect(await h.forwarder.drain()).toBeGreaterThanOrEqual(1);
  });
});

describe('audit forwarding budget (FIX-064)', () => {
  it('FIX-064: a backlog larger than the budget is forwarded over several drain calls, in order', async () => {
    const h = harness();
    h.define('d', completes());
    const inst = await h.instance('d');
    for (let i = 0; i < 6; i++) await h.delegate(inst.id, {}, `k${i}`);
    const seen: string[] = [];
    const forwarder = new AuditForwarder({
      store: h.store,
      now: h.clock.iso,
      drainBudgetMs: 25_000,
      sink: {
        record: async (e) => {
          seen.push(String(e.details?.auditId));
          h.clock.advanceBy(10_000);
        },
      },
    });
    expect(await forwarder.drain()).toBe(3);
    let total = 3;
    for (let calls = 0; calls < 40; calls++) {
      const n = await forwarder.drain();
      if (!n) break;
      total += n;
    }
    expect(total).toBeGreaterThanOrEqual(6);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(await forwarder.drain()).toBe(0);
  });
});

describe('audit forwarding is observable (FEAT-075)', () => {
  it('FEAT-075: a refusing sink is counted per attempt and reported by stuck(), and the count stops when it recovers', async () => {
    const h = harness();
    h.define('d', completes());
    const inst = await h.instance('d');
    for (let i = 0; i < 3; i++) await h.delegate(inst.id, {}, `k${i}`);
    const counted: { name: string; attributes?: Record<string, unknown> }[] =
      [];
    let refusing = true;
    const forwarder = new AuditForwarder({
      store: h.store,
      telemetry: {
        startSpan: () => ({
          traceparent: undefined,
          setAttributes() {},
          fail() {},
          end() {},
        }),
        count: (name, _n, attributes) =>
          void counted.push({ name, attributes }),
        record() {},
      },
      sink: {
        record: async () => {
          if (refusing) throw new Error('sink down');
        },
      },
    });
    expect(await forwarder.stuck(1)).toEqual([]);
    for (let i = 0; i < 3; i++) expect(await forwarder.drain()).toBe(0);
    expect(counted.map((c) => c.name)).toEqual(
      Array(3).fill('agentropy.audit.forward_failures'),
    );
    expect(counted[0]!.attributes).toMatchObject({
      'agentropy.audit.type': expect.any(String),
    });
    const [stuck, ...more] = await forwarder.stuck(3);
    expect(more).toEqual([]); // forwarding halts at the first refused row
    expect(stuck).toMatchObject({ attempts: 3, type: expect.any(String) });
    expect(await forwarder.stuck(4)).toEqual([]);
    refusing = false;
    expect(await forwarder.drain()).toBeGreaterThan(0);
    expect(await forwarder.stuck(1)).toEqual([]);
    expect(counted).toHaveLength(3);
  });
});
