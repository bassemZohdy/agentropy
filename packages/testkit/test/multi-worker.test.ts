// FEAT-028.2: multi-worker pool (M3-02, R-10) — several runtimes sharing one store. Exactly-once dispatch, lease
// takeover from a stalled worker with fencing, cancel across workers, fair dispatch across tenants, a store-wide
// per-tenant concurrency limit, three real worker processes on one SQLite file, and policy cache invalidation
// shared by every worker (FEAT-033.1).
import { PGlite } from '@electric-sql/pglite';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type PolicyDecisionPoint,
  type PolicyRequest,
  type Store,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it, vi } from 'vitest';
import {
  CachingPolicyDecisionPoint,
  createLocalApp,
  fairOrder,
  type LocalApp,
  type TenantQuota,
} from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { SqliteStore } from '../../store-sqlite/src/index.js';
import { PostgresStore } from '../../store-postgres/src/index.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const user = (tenantId: string): TrustedPrincipal => ({
  id: `owner-${tenantId}`,
  type: 'user',
  tenantId,
});

const def: AgentDefinition = {
  id: 'worker',
  version: '1.0.0',
  displayName: 'worker',
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'worker', version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
};

interface Cluster {
  store: Store;
  clock: FakeClock;
  workers: LocalApp[];
  instance(tenantId: string): Promise<string>;
  submit(instanceId: string, tenantId: string, key: string): Promise<string>;
  executions(): Promise<
    { taskId: string; state: string; workerId?: string; tenantId?: string }[]
  >;
}

function cluster(
  store: Store,
  agents: Agent[],
  quotas?: (tenantId: string) => TenantQuota | undefined,
  o: { relayLease?: boolean } = {},
): Cluster {
  const clock = new FakeClock('2026-11-06T00:00:00.000Z');
  const workers = agents.map((agent, i) => {
    const app = createLocalApp({
      store,
      pdp: new FakePolicy(),
      now: clock.iso,
      profiles: BUILTIN_PROFILES,
      runtime: { workerId: `w${i + 1}` },
      limits: { poolSize: 4, leaseMs: 10_000, cancelGraceMs: 0 },
      ...(quotas ? { quotas } : {}),
      ...(o.relayLease ? { relay: { relayId: `w${i + 1}` } } : {}),
    });
    app.define(def, agent);
    return app;
  });
  const front = workers[0]!;
  return {
    store,
    clock,
    workers,
    instance: async (tenantId) =>
      (
        await front.createInstance(
          {
            definition: { id: 'worker', version: '1.0.0' },
            ownerId: user(tenantId).id,
            idempotencyKey: `inst-${tenantId}`,
          },
          user(tenantId),
        )
      ).id,
    submit: async (instanceId, tenantId, key) =>
      (
        await front.delegate(
          {
            target: { instanceId },
            input: { key },
            idempotencyKey: key,
            correlationId: key,
          },
          user(tenantId),
        )
      ).taskId,
    executions: async () =>
      (
        await store.transaction((tx) =>
          tx.find<{
            taskId: string;
            state: string;
            workerId?: string;
            tenantId?: string;
          }>('executions', {}),
        )
      ).map((d) => d.value),
  };
}

/** Tick every worker concurrently until no queued or running work is left. */
async function drain(c: Cluster) {
  for (let round = 0; round < 50; round++) {
    await Promise.all(c.workers.map((w) => w.runtime.tick()));
    await Promise.all(c.workers.map((w) => w.runtime.idle()));
    const open = (await c.executions()).filter((e) =>
      ['queued', 'leased', 'running'].includes(e.state),
    );
    if (!open.length) return;
  }
  throw new Error('cluster did not drain');
}

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};

const stores: [string, () => Store][] = [
  ['sqlite file', () => sqliteTempStore()],
  [
    'postgres (PGlite)',
    () => new PostgresStore({ client: new PGlite(), ownsConnection: true }),
  ],
];

describe.each(stores)('multi-worker pool on %s (M3-02)', (_name, make) => {
  it('dispatches every task exactly once across three workers', async () => {
    const calls = new Map<string, number>();
    const agent: Agent = {
      handle: async (inv) => {
        calls.set(inv.taskId, (calls.get(inv.taskId) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 2));
        return { kind: 'completed', output: inv.input };
      },
    };
    const c = cluster(make(), [agent, agent, agent]);
    const inst = await c.instance('t-1');
    const ids: string[] = [];
    for (let i = 0; i < 24; i++) ids.push(await c.submit(inst, 't-1', `k${i}`));
    await drain(c);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(calls.size).toBe(24);
    const execs = await c.executions();
    expect(execs.filter((e) => e.state === 'succeeded')).toHaveLength(24);
    expect(new Set(execs.map((e) => e.workerId)).size).toBeGreaterThan(1);
    for (const id of ids)
      expect((await c.workers[2]!.getTask(id, user('t-1'))).status).toBe(
        'completed',
      );
    await c.store.close();
  });

  it('with a relay lease one worker publishes each event once, and a subscriber on another worker still wakes (FEAT-032.5)', async () => {
    const agent: Agent = {
      handle: async (inv) => ({ kind: 'completed', output: inv.input }),
    };
    const c = cluster(make(), [agent, agent], undefined, { relayLease: true });
    const delivered: [number, string][] = [];
    c.workers.forEach((w, i) =>
      w.relay.register({
        id: 'count',
        handle: async (e) => void delivered.push([i, e.eventId]),
      }),
    );
    const inst = await c.instance('t-1');
    const id = await c.submit(inst, 't-1', 'k');
    const statuses = (async () => {
      const out: string[] = [];
      for await (const e of c.workers[1]!.subscribe(id, user('t-1')))
        out.push(e.status);
      return out;
    })();
    await drain(c);
    await Promise.all(c.workers.map((w) => w.relay.drain()));
    expect((await statuses).at(-1)).toBe('completed');
    // Only the lease holder delivered, each event once.
    expect(new Set(delivered.map(([w]) => w)).size).toBe(1);
    expect(new Set(delivered.map(([, e]) => e)).size).toBe(delivered.length);
    await c.store.close();
  });

  it('audit appends from every worker form one verifiable chain per tenant', async () => {
    const agent: Agent = {
      handle: async (inv) => ({ kind: 'completed', output: inv.input }),
    };
    const c = cluster(make(), [agent, agent, agent]);
    const inst = await c.instance('t-1');
    // Acceptances through all three workers at once, then their executions: every one appends audit rows.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        c.workers[i % 3]!.delegate(
          {
            target: { instanceId: inst },
            input: { i },
            idempotencyKey: `a${i}`,
            correlationId: `a${i}`,
          },
          user('t-1'),
        ),
      ),
    );
    await drain(c);
    expect(
      await c.workers[1]!.auditLog.verify('t-1', user('t-1')),
    ).toMatchObject({ ok: true });
    const rows = await c.store.transaction((tx) =>
      tx.find<{ prevHash: string; hash: string }>('audit', {
        where: { tenantId: 't-1' },
        orderBy: 'seq',
      }),
    );
    // Linear: each link names the one before it, so no two appends forked from the same head.
    expect(new Set(rows.map((r) => r.value.prevHash)).size).toBe(rows.length);
    await c.store.close();
  });

  it('a stalled worker loses its lease to another worker; its late result is fenced', async () => {
    const stuck = gate();
    let lateResult: unknown;
    const stalling: Agent = {
      handle: async (_inv, ctx) => {
        await stuck.opened;
        lateResult = ctx.signal.reason;
        return { kind: 'completed', output: 'late' };
      },
    };
    const healthy: Agent = {
      handle: async () => ({ kind: 'completed', output: 'from w2' }),
    };
    const c = cluster(make(), [stalling, healthy]);
    const [w1, w2] = c.workers as [LocalApp, LocalApp];
    const inst = await c.instance('t-1');
    const id = await c.submit(inst, 't-1', 'k');
    expect(await w1.runtime.tick()).toBe(1);
    // w1 stops heartbeating; after the lease expires w2 recovers the task and runs the retry.
    c.clock.advanceBy(11_000);
    await w2.runtime.tick();
    await w2.runtime.idle();
    await w2.runtime.tick();
    await w2.runtime.idle();
    expect(await w2.getResult(id, user('t-1'))).toBe('from w2');
    // w1's next heartbeat sees the lost lease and aborts its handler; the late result changes nothing.
    await w1.runtime.tick();
    stuck.open();
    await w1.runtime.idle();
    expect((lateResult as { code?: string })?.code).toBe('StaleRevision');
    expect(await w2.getResult(id, user('t-1'))).toBe('from w2');
    const execs = await c.executions();
    expect(execs.map((e) => [e.workerId, e.state]).sort()).toEqual([
      ['w1', 'lost'],
      ['w2', 'succeeded'],
    ]);
    await c.store.close();
  });

  it('a cancel accepted by one worker stops the handler running on another', async () => {
    const started = gate();
    const sleeper: Agent = {
      handle: async (_inv, ctx) => {
        started.open();
        await new Promise((r) =>
          ctx.signal.addEventListener('abort', r, { once: true }),
        );
        return { kind: 'completed', output: 'ignored' };
      },
    };
    const c = cluster(make(), [sleeper, sleeper]);
    const [w1, w2] = c.workers as [LocalApp, LocalApp];
    const inst = await c.instance('t-1');
    const id = await c.submit(inst, 't-1', 'k');
    await w1.runtime.tick();
    await started.opened;
    await w2.cancel(id, user('t-1'));
    await w1.runtime.tick(); // heartbeat observes cancelRequestedAt
    await w1.runtime.idle();
    expect((await w2.getTask(id, user('t-1'))).status).toBe('cancelled');
    await c.store.close();
  });
});

describe('lease heartbeat of a started worker (FIX-051)', () => {
  /** The lease expiry of the one execution in the store. */
  const leaseOf = async (c: Cluster) =>
    (
      await c.store.transaction((tx) =>
        tx.find<{ leaseExpiresAt?: string }>('executions', {}),
      )
    )[0]?.value.leaseExpiresAt ?? '';

  /** w1 holds its handler until `finish` opens; w2 would complete a task it recovered at once. */
  const pair = () => {
    const started = gate();
    const finish = gate();
    let runs = 0;
    const held: Agent = {
      handle: async () => {
        runs++;
        started.open();
        await finish.opened;
        return { kind: 'completed', output: 'from w1' };
      },
    };
    const eager: Agent = {
      handle: async () => {
        runs++;
        return { kind: 'completed', output: 'from w2' };
      },
    };
    const c = cluster(sqliteTempStore(), [held, eager]);
    const [w1, w2] = c.workers as [LocalApp, LocalApp];
    return { c, w1, w2, started, finish, runs: () => runs };
  };

  it('a worker whose tick is blocked longer than the lease keeps it; another worker recovers nothing', async () => {
    const { c, w1, w2, started, finish, runs } = pair();
    const hold = gate();
    let block = false;
    let blocked = 0;
    w1.wakeups.addSweep(async () => {
      if (!block) return;
      blocked++;
      await hold.opened;
    });
    const inst = await c.instance('t-1');
    const id = await c.submit(inst, 't-1', 'k');
    const stop = w1.start(5, { heartbeatMs: 10 });
    await started.opened;
    // From here on w1's scheduler tick hangs in a sweep (a slow peer, policy point or sink): no tick renews anything.
    block = true;
    await vi.waitFor(() => expect(blocked).toBe(1));
    const granted = await leaseOf(c);
    c.clock.advanceBy(6_000);
    // The heartbeat does not wait for the tick: the lease (10 s) is extended although the tick is stuck.
    await vi.waitFor(async () =>
      expect((await leaseOf(c)) > granted).toBe(true),
    );
    c.clock.advanceBy(6_000); // past the lease as first granted
    expect(await w2.runtime.tick()).toBe(0);
    await w2.runtime.idle();
    expect((await c.executions()).map((e) => [e.workerId, e.state])).toEqual([
      ['w1', 'running'],
    ]);
    hold.open();
    finish.open();
    await vi.waitFor(async () =>
      expect((await w2.getTask(id, user('t-1'))).status).toBe('completed'),
    );
    await stop();
    expect(await w2.getResult(id, user('t-1'))).toBe('from w1');
    expect(runs()).toBe(1);
    await c.store.close();
  });

  it('a stopping worker keeps the leases of the executions it waits for', async () => {
    const { c, w1, w2, started, finish, runs } = pair();
    const inst = await c.instance('t-1');
    const id = await c.submit(inst, 't-1', 'k');
    const stop = w1.start(5, { heartbeatMs: 10 });
    await started.opened;
    const granted = await leaseOf(c);
    let stopped = false;
    const stopping = stop().then(() => (stopped = true));
    c.clock.advanceBy(6_000);
    await vi.waitFor(async () =>
      expect((await leaseOf(c)) > granted).toBe(true),
    );
    c.clock.advanceBy(6_000);
    expect(await w2.runtime.tick()).toBe(0);
    expect(stopped).toBe(false); // still waiting for its execution
    finish.open();
    await stopping;
    expect(await w2.getResult(id, user('t-1'))).toBe('from w1');
    expect(runs()).toBe(1);
    // Once the pool is empty and the worker stopped, nothing renews any more.
    const settled = await leaseOf(c);
    c.clock.advanceBy(6_000);
    await new Promise((r) => setTimeout(r, 40));
    expect(await leaseOf(c)).toBe(settled);
    await c.store.close();
  });

  it('refuses a heartbeat interval that is not shorter than the lease', () => {
    const { c, w1 } = pair();
    for (const heartbeatMs of [0, 1.5, 10_000, 20_000])
      expect(() => w1.start(5, { heartbeatMs })).toThrowError(
        expect.objectContaining({ code: 'InvalidConfiguration' }),
      );
    expect(w1.schedulerStatus().running).toBe(false);
    void c.store.close();
  });
});

describe('fair dispatch and per-tenant concurrency (M3-02)', () => {
  it('fairOrder interleaves tenants and keeps each tenant’s order', () => {
    const e = (id: string, tenantId: string) => ({ id, value: { tenantId } });
    expect(
      fairOrder([
        e('a1', 'a'),
        e('a2', 'a'),
        e('a3', 'a'),
        e('b1', 'b'),
        e('c1', 'c'),
        e('b2', 'b'),
      ]).map((x) => x.id),
    ).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  });

  it('a tenant with a backlog does not starve a tenant that queued later', async () => {
    const release = gate();
    const agent: Agent = {
      handle: async () => {
        await release.opened;
        return { kind: 'completed', output: null };
      },
    };
    const c = cluster(sqliteTempStore(), [agent]);
    const a = await c.instance('t-a');
    const b = await c.instance('t-b');
    for (let i = 0; i < 6; i++) await c.submit(a, 't-a', `a${i}`);
    await c.submit(b, 't-b', 'b0');
    // poolSize 4: strict FIFO would run four t-a tasks; fair order starts t-b's task in the first tick.
    await c.workers[0]!.runtime.tick();
    const running = (await c.executions()).filter((e) => e.state === 'running');
    expect(running).toHaveLength(4);
    expect(running.map((e) => e.tenantId)).toContain('t-b');
    release.open();
    await drain(c);
    await c.store.close();
  });

  it('maxConcurrentExecutions holds across workers; excess work waits queued', async () => {
    const release = gate();
    let peak = 0;
    let now = 0;
    const agent: Agent = {
      handle: async () => {
        peak = Math.max(peak, ++now);
        await release.opened;
        now--;
        return { kind: 'completed', output: null };
      },
    };
    const c = cluster(sqliteTempStore(), [agent, agent, agent], (t) =>
      t === 't-1' ? { maxConcurrentExecutions: 2 } : undefined,
    );
    const inst = await c.instance('t-1');
    for (let i = 0; i < 6; i++) await c.submit(inst, 't-1', `k${i}`);
    await Promise.all(c.workers.map((w) => w.runtime.tick()));
    const execs = await c.executions();
    expect(execs.filter((e) => e.state === 'running')).toHaveLength(2);
    expect(execs.filter((e) => e.state === 'queued')).toHaveLength(4);
    release.open();
    await drain(c);
    expect(peak).toBe(2);
    await c.store.close();
  });
});

describe('worker processes sharing one SQLite file (M3-02)', () => {
  it('three processes complete every task exactly once', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'agentropy-mw-')), 'db');
    const app = createLocalApp({
      store: new SqliteStore({ path }),
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
    });
    app.define(def, {
      handle: async () => ({ kind: 'completed', output: null }),
    });
    const inst = (
      await app.createInstance(
        {
          definition: { id: 'worker', version: '1.0.0' },
          ownerId: user('t-1').id,
          idempotencyKey: 'i',
        },
        user('t-1'),
      )
    ).id;
    const ids: string[] = [];
    for (let i = 0; i < 30; i++)
      ids.push(
        (
          await app.delegate(
            {
              target: { instanceId: inst },
              input: {},
              idempotencyKey: `k${i}`,
              correlationId: `c${i}`,
            },
            user('t-1'),
          )
        ).taskId,
      );
    await app.store.close();

    const script = join(import.meta.dirname, 'fixtures', 'sqlite-worker.mjs');
    const barrier = await mkdtemp(join(tmpdir(), 'agentropy-mw-barrier-'));
    const run = (n: number) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [script, path, `p${n}`, barrier, '3'],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => resolve({ code, out }));
      });
    const results = await Promise.all([run(1), run(2), run(3)]);
    for (const r of results) expect(r.code, r.out).toBe(0);

    const check = new SqliteStore({ path });
    const execs = (
      await check.transaction((tx) =>
        tx.find<{ taskId: string; state: string; workerId: string }>(
          'executions',
          {},
        ),
      )
    ).map((d) => d.value);
    expect(execs).toHaveLength(30);
    expect(execs.every((e) => e.state === 'succeeded')).toBe(true);
    expect(new Set(execs.map((e) => e.taskId)).size).toBe(30);
    const byWorker = new Set(execs.map((e) => e.workerId));
    expect(byWorker.size).toBeGreaterThan(1);
    const tasks = await check.transaction((tx) =>
      tx.find<{ status: string }>('tasks', {}),
    );
    expect(tasks.every((t) => t.value.status === 'completed')).toBe(true);
    await check.close();
  }, 60_000);
});

describe('policy decision cache across workers (FEAT-033.1)', () => {
  it('a grant revoked through one worker is not served from another worker cache', async () => {
    const store = sqliteTempStore();
    let revoked = false;
    let calls = 0;
    const inner: PolicyDecisionPoint = {
      decide: async () => {
        calls++;
        return { effect: revoked ? 'deny' : 'allow' };
      },
    };
    const caches = [1, 2].map(
      () =>
        new CachingPolicyDecisionPoint(inner, {
          shared: { store, syncMs: 0 },
        }),
    );
    const [w1] = caches.map((pdp) =>
      createLocalApp({ store, pdp, profiles: BUILTIN_PROFILES }),
    );
    const agent: TrustedPrincipal = {
      id: 'helper',
      type: 'agent',
      tenantId: 't-1',
      delegatedAuthorityRef: 'grant-7',
    };
    const request: PolicyRequest = {
      principal: agent,
      action: 'tool:x:call',
      resource: { type: 'capability', id: 'tool-use', tenantId: 't-1' },
    };
    await caches[1]!.decide(request);
    await caches[1]!.decide(request);
    expect(calls).toBe(1);
    revoked = true;
    await w1!.revokeAuthority('grant-7', {
      id: 'ops',
      type: 'service',
      tenantId: 't-1',
    });
    expect((await caches[1]!.decide(request)).effect).toBe('deny');
    expect(calls).toBe(2);
    await store.close();
  });
});
