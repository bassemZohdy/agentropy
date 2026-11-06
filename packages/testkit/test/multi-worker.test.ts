// FEAT-028.2: multi-worker pool (M3-02, R-10) — several runtimes sharing one store. Exactly-once dispatch, lease
// takeover from a stalled worker with fencing, cancel across workers, fair dispatch across tenants, a store-wide
// per-tenant concurrency limit, and three real worker processes on one SQLite file.
import { PGlite } from '@electric-sql/pglite';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type Store,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
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
    const run = (n: number) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [script, path, `p${n}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
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
