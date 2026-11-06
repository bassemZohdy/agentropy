// FEAT-033.1: a policy decision cache shared through the store. An invalidation recorded by any worker drops
// matching cached decisions on every other worker within `syncMs`; a failed read of the invalidations fails closed.
import type {
  PolicyDecisionPoint,
  PolicyRequest,
  Store,
  TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  CachingPolicyDecisionPoint,
  POLICY_INVALIDATION_RETENTION_MS,
  recordPolicyInvalidation,
} from '../src/index.js';
import { code, sqliteTempStore } from './harness.js';

const alice: TrustedPrincipal = {
  id: 'alice',
  type: 'agent',
  tenantId: 't-1',
  delegatedAuthorityRef: 'grant-1',
};
const req = (principal = alice): PolicyRequest => ({
  principal,
  action: 'tool:x:call',
  resource: { type: 'capability', id: 'tool-use', tenantId: 't-1' },
});

/** A PDP that counts its calls and denies once `revoked` is set. */
function counting() {
  const pdp = {
    calls: 0,
    revoked: false,
    decide: async () => {
      pdp.calls++;
      return { effect: pdp.revoked ? 'deny' : 'allow' } as const;
    },
  };
  return pdp satisfies PolicyDecisionPoint;
}

let n = 0;
const record = (
  store: Store,
  filter: { grantRef?: string; tenantId?: string },
  at = new Date().toISOString(),
) =>
  store.transaction((tx) =>
    recordPolicyInvalidation(tx, `inv-${n++}`, filter, at),
  );

describe('shared policy decision cache (FEAT-033.1)', () => {
  it('an invalidation recorded by one worker drops the allow another worker cached', async () => {
    const store = sqliteTempStore();
    const inner = counting();
    const a = new CachingPolicyDecisionPoint(inner, {
      shared: { store, syncMs: 0 },
    });
    const b = new CachingPolicyDecisionPoint(inner, {
      shared: { store, syncMs: 0 },
    });
    await a.decide(req());
    await b.decide(req());
    await b.decide(req());
    expect(inner.calls).toBe(2);
    inner.revoked = true;
    // Worker A revokes: its own entry goes at once, B's on its next read of the store.
    a.invalidate({ grantRef: 'grant-1' });
    await record(store, { tenantId: 't-1', grantRef: 'grant-1' });
    expect((await b.decide(req())).effect).toBe('deny');
    expect(inner.calls).toBe(3);
    // Other grants stay cached; an invalidation is applied once.
    inner.revoked = false;
    const other = { ...alice, delegatedAuthorityRef: 'grant-2' };
    await b.decide(req(other));
    await b.decide(req(other));
    expect(inner.calls).toBe(4);
    await store.close();
  });

  it('reads the store at most every syncMs, so staleness is bounded by syncMs instead of ttlMs', async () => {
    const store = sqliteTempStore();
    const inner = counting();
    let now = Date.parse('2026-11-06T00:00:00.000Z');
    const iso = () => new Date(now).toISOString();
    const b = new CachingPolicyDecisionPoint(inner, {
      ttlMs: 60_000,
      now: iso,
      shared: { store, syncMs: 1_000 },
    });
    await b.decide(req());
    await record(store, { grantRef: 'grant-1' }, iso());
    now += 500;
    expect((await b.decide(req())).effect).toBe('allow'); // within syncMs: still the cached allow
    expect(inner.calls).toBe(1);
    now += 600;
    inner.revoked = true;
    expect((await b.decide(req())).effect).toBe('deny');
    expect(inner.calls).toBe(2);
    await store.close();
  });

  it('a failed read of the invalidations drops the cache and asks the PDP (fail closed)', async () => {
    const store = sqliteTempStore();
    const inner = counting();
    let broken = false;
    const flaky: Store = {
      transaction: (fn) =>
        broken ? Promise.reject(new Error('down')) : store.transaction(fn),
      close: () => store.close(),
    } as Store;
    const b = new CachingPolicyDecisionPoint(inner, {
      shared: { store: flaky, syncMs: 0 },
    });
    await b.decide(req());
    broken = true;
    await b.decide(req());
    await b.decide(req());
    expect(inner.calls).toBe(3);
    // An invalidation recorded during the outage is applied by the first read that succeeds.
    await record(store, { grantRef: 'grant-1' });
    broken = false;
    await b.decide(req());
    expect(inner.calls).toBe(4);
    await b.decide(req());
    expect(inner.calls).toBe(4);
    await store.close();
  });

  it('keeps no grant reference in the store and prunes rows past the retention', async () => {
    const store = sqliteTempStore();
    const t0 = Date.parse('2026-11-06T00:00:00.000Z');
    await record(
      store,
      { grantRef: 'secret-grant' },
      new Date(t0).toISOString(),
    );
    await record(
      store,
      { grantRef: 'g' },
      new Date(t0 + POLICY_INVALIDATION_RETENTION_MS + 1).toISOString(),
    );
    const rows = await store.transaction((tx) =>
      tx.find('policyInvalidations', {}),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('secret-grant');
    expect(JSON.stringify(rows)).not.toContain('"g"');
    await store.close();
  });

  it('refuses a shared cache whose TTL outlives the retained invalidations', async () => {
    const store = sqliteTempStore();
    expect(
      await code(
        (async () =>
          new CachingPolicyDecisionPoint(counting(), {
            ttlMs: POLICY_INVALIDATION_RETENTION_MS + 1,
            shared: { store },
          }))(),
      ),
    ).toBe('InvalidConfiguration');
    await store.close();
  });
});
