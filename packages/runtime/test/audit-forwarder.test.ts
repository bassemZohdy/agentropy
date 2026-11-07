// FEAT-039.1: the audit forwarder reads what is still to be forwarded, not the whole audit log on every tick.
import type { Store, StoreTx } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
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
