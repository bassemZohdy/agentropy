// FEAT-028.7: benchmarks (M3-06) — throughput, accept-to-complete latency, crash recovery and multi-worker
// scaling, on SQLite and PostgreSQL (PGlite). Each case prints a `[bench]` JSON line; the numbers recorded in
// docs/review/2026-11-06-m3-benchmarks.md come from these lines, and docs/slo.md sets targets from them. The
// assertions are deliberately loose floors (an order of magnitude under the measurements) so CI noise cannot fail
// the suite; regressions are spotted by comparing the printed lines.
//
// FEAT-031: with AGENTROPY_PG_URL set (e.g. postgres://postgres:pw@127.0.0.1:55432/agentropy) the same cases also
// run on a PostgreSQL server through node-postgres, each store in a fresh schema. That opt-in admits only the
// database's host:port through the offline network guard (allowNetwork); without it nothing here touches the network.
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type Store,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { createLocalApp, type LocalApp } from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { PostgresStore } from '../../store-postgres/src/index.js';
import {
  FakeClock,
  FakePolicy,
  allowNetwork,
  endpointOf,
} from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };

const def: AgentDefinition = {
  id: 'bench',
  version: '1.0.0',
  displayName: 'bench',
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'bench', version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
};

const quick: Agent = {
  handle: async (inv) => ({ kind: 'completed', output: inv.input }),
};

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const round = (n: number) => Math.round(n * 10) / 10;

function bench(name: string, data: Record<string, unknown>) {
  console.log(
    `[bench] ${JSON.stringify({ name, node: process.version, ...data })}`,
  );
}

function workers(store: Store, n: number, clock: FakeClock, agent = quick) {
  return Array.from({ length: n }, (_, i) => {
    const app = createLocalApp({
      store,
      pdp: new FakePolicy(),
      now: clock.iso,
      profiles: BUILTIN_PROFILES,
      runtime: { workerId: `w${i}` },
      // One relay leads, as in a deployment (docs/deployment.md); the others only wake their own subscribers.
      relay: { relayId: `w${i}` },
      limits: { poolSize: 8, leaseMs: 30_000, cancelGraceMs: 0 },
    });
    app.define(def, agent);
    return app;
  });
}

async function instance(app: LocalApp) {
  return (
    await app.createInstance(
      {
        definition: { id: 'bench', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'bench',
      },
      alice,
    )
  ).id;
}

const delegate = (app: LocalApp, inst: string, key: string) =>
  app.delegate(
    {
      target: { instanceId: inst },
      input: { key },
      idempotencyKey: key,
      correlationId: key,
    },
    alice,
  );

const PG_URL = process.env['AGENTROPY_PG_URL'];
if (PG_URL) allowNetwork([endpointOf(PG_URL, 5432)]); // explicit opt-in: only this database
let schemas = 0;
const pgServer = (): Store =>
  new PostgresStore({
    pool: new pg.Pool({ connectionString: PG_URL, max: 8 }),
    schema: `bench_${process.pid}_${Date.now().toString(36)}_${schemas++}`,
    ownsConnection: true,
  });

const stores: [string, () => Store][] = [
  ['sqlite', () => sqliteTempStore()],
  [
    'postgres-pglite',
    () => new PostgresStore({ client: new PGlite(), ownsConnection: true }),
  ],
  ...(PG_URL ? [['postgres-server', pgServer] as [string, () => Store]] : []),
];

describe.each(stores)('benchmarks on %s (M3-06)', (storeName, make) => {
  it('throughput: accept and complete a batch of tasks', async () => {
    const N = 200;
    const store = make();
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const [app] = workers(store, 1, clock) as [LocalApp];
    const inst = await instance(app);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await delegate(app, inst, `k${i}`);
    const accepted = performance.now();
    await app.runUntilIdle(100);
    const done = performance.now();
    const acceptPerSec = N / ((accepted - t0) / 1000);
    const completePerSec = N / ((done - accepted) / 1000);
    bench('throughput', {
      store: storeName,
      tasks: N,
      acceptPerSec: round(acceptPerSec),
      completePerSec: round(completePerSec),
    });
    expect(acceptPerSec).toBeGreaterThan(5);
    expect(completePerSec).toBeGreaterThan(5);
    await store.close();
  }, 120_000);

  it('latency: accept-to-complete for single tasks on an idle runtime', async () => {
    const N = 40;
    const store = make();
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const [app] = workers(store, 1, clock) as [LocalApp];
    const inst = await instance(app);
    const accept: number[] = [];
    const total: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await delegate(app, inst, `l${i}`);
      const t1 = performance.now();
      await app.runUntilIdle();
      const t2 = performance.now();
      accept.push(t1 - t0);
      total.push(t2 - t0);
    }
    bench('latency', {
      store: storeName,
      samples: N,
      acceptP50Ms: round(percentile(accept, 50)),
      acceptP95Ms: round(percentile(accept, 95)),
      completeP50Ms: round(percentile(total, 50)),
      completeP95Ms: round(percentile(total, 95)),
    });
    expect(percentile(total, 95)).toBeLessThan(2_000);
    await store.close();
  }, 120_000);

  it('recovery: work of a crashed worker resumes on another after lease expiry', async () => {
    const N = 20;
    const store = make();
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const hang: Agent = { handle: () => new Promise(() => undefined) };
    const [crashed] = workers(store, 1, clock, hang) as [LocalApp];
    const [survivor] = workers(store, 1, clock) as [LocalApp];
    const inst = await instance(crashed);
    for (let i = 0; i < N; i++) await delegate(crashed, inst, `r${i}`);
    // The crashing worker leases its pool's worth and never finishes; the rest stays queued.
    await crashed.runtime.tick();
    clock.advanceBy(31_000); // lease expiry: the detection time is the lease (30 s here, 60 s by default)
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      await survivor.runtime.tick();
      await survivor.runtime.idle();
    }
    const recoverMs = performance.now() - t0;
    const execs = await store.transaction((tx) =>
      tx.find<{ state: string }>('executions', {}),
    );
    const succeeded = execs.filter((e) => e.value.state === 'succeeded').length;
    bench('recovery', {
      store: storeName,
      tasks: N,
      lostLeases: execs.filter((e) => e.value.state === 'lost').length,
      leaseMs: 30_000,
      drainAfterExpiryMs: round(recoverMs),
    });
    expect(succeeded).toBe(N);
    await store.close();
  }, 120_000);
});

const scaling: [string, () => Store][] = [
  ['sqlite', () => sqliteTempStore()],
  ...(PG_URL ? [['postgres-server', pgServer] as [string, () => Store]] : []),
];

describe.each(scaling)(
  'multi-worker scaling on %s (M3-06)',
  (storeName, make) => {
    it('completes the same batch with 1, 2 and 4 in-process workers', async () => {
      const N = 120;
      const out: Record<string, number> = {};
      for (const n of [1, 2, 4]) {
        const store = make();
        const clock = new FakeClock('2026-11-06T00:00:00.000Z');
        const ws = workers(store, n, clock, {
          handle: async (inv) => {
            await new Promise((r) => setTimeout(r, 5)); // simulated I/O in the handler
            return { kind: 'completed', output: inv.input };
          },
        });
        const inst = await instance(ws[0]!);
        for (let i = 0; i < N; i++) await delegate(ws[0]!, inst, `m${i}`);
        const t0 = performance.now();
        for (let round = 0; round < 200; round++) {
          await Promise.all(ws.map((w) => w.runtime.tick()));
          await Promise.all(ws.map((w) => w.runtime.idle()));
          const open = (
            await store.transaction((tx) =>
              tx.find<{ state: string }>('executions', {
                where: { state: 'queued' },
              }),
            )
          ).length;
          if (!open) break;
        }
        out[`workers${n}PerSec`] = round(N / ((performance.now() - t0) / 1000));
        await store.close();
      }
      bench('multi-worker', {
        store: storeName,
        tasks: N,
        handlerIoMs: 5,
        ...out,
      });
      expect(out.workers2PerSec!).toBeGreaterThan(out.workers1PerSec! * 0.4);
    }, 120_000);
  },
);

describe('wake-up polling with 10k waiters (FEAT-033.2)', () => {
  it('an indexed poll does not grow with the number of armed registrations', async () => {
    const W = 10_000;
    const store = sqliteTempStore();
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const [app] = workers(store, 1, clock);
    // Registrations armed on far timers; their tasks are not needed to measure what a poll has to read.
    await store.transaction(async (tx) => {
      for (let i = 0; i < W; i++)
        await tx.insert('wakeups', `wk-${i}`, {
          id: `wk-${i}`,
          taskId: `task-${i}`,
          conditions: [{ kind: 'timer', at: '2027-01-01T00:00:00.000Z' }],
          conditionDue: ['2027-01-01T00:00:00.000Z'],
          onTimeout: 'resume',
          status: 'armed',
          dueAt: '2027-01-01T00:00:00.000Z',
          checkAt: '2027-01-01T00:00:00.000Z',
        });
    });
    const time = async (n: number) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await app!.wakeups.poll();
      return (performance.now() - t0) / n;
    };
    const fullScanMs = await time(1); // the first poll of a process scans everything
    const indexedMs = await time(20);
    bench('wakeup-poll', {
      store: 'sqlite',
      armed: W,
      fullScanMs: round(fullScanMs),
      indexedPollMs: round(indexedMs),
    });
    expect(indexedMs).toBeLessThan(fullScanMs / 5);
    await store.close();
  }, 120_000);
});
