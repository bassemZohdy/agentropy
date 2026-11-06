// FEAT-028.1: the runtime on the PostgreSQL adapter (embedded PGlite) — a task that waits on a timer survives a
// store reopen and completes, with the audit chain still verifying.
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_PROFILES,
  type Agent,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../../runtime/src/index.js';
import {
  PostgresStore,
  type PgClient,
} from '../../store-postgres/src/index.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const ops: TrustedPrincipal = { id: 'ops', type: 'service', tenantId: 't-1' };

const sleeper: Agent = {
  handle: async (inv) =>
    inv.activation === 1
      ? {
          kind: 'waiting',
          wakeup: {
            anyOf: [{ kind: 'timer', at: '2026-11-05T01:00:00.000Z' }],
          },
          checkpoint: { step: 1 },
        }
      : { kind: 'completed', output: { resumedFrom: inv.checkpoint } },
};

function app(dir: string, clock: FakeClock) {
  const a = createLocalApp({
    store: new PostgresStore({ client: new PGlite(dir), ownsConnection: true }),
    pdp: new FakePolicy(),
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
  });
  a.define(
    {
      id: 'sleeper',
      version: '1.0.0',
      displayName: 'sleeper',
      profile: { id: 'task', version: '1.0.0' },
      implementation: {
        providerId: 'native-ts',
        providerVersion: '1.0.0',
        artifact: { id: 'sleeper', version: '1.0.0' },
      },
      inputSchema: true,
      runtimeRequirements: { guarantees: [] },
      policyRef: { id: 'default', version: '1.0.0' },
    },
    sleeper,
  );
  return a;
}

describe('runtime on PostgreSQL (M3-07)', () => {
  it('accepts a task in at most 12 round trips (FEAT-032.2, R-02)', async () => {
    const db = new PGlite();
    let sent = 0;
    const client: PgClient = {
      query: (text, params) => {
        sent++;
        return db.query(text, params);
      },
    };
    const a = createLocalApp({
      store: new PostgresStore({ client }),
      pdp: new FakePolicy(),
      now: new FakeClock().iso,
      profiles: BUILTIN_PROFILES,
    });
    a.define(
      {
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
      },
      { handle: async (inv) => ({ kind: 'completed', output: inv.input }) },
    );
    const inst = await a.createInstance(
      {
        definition: { id: 'echo', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'i',
      },
      alice,
    );
    const delegate = (k: string) =>
      a.delegate(
        {
          target: { instanceId: inst.id },
          input: k,
          idempotencyKey: k,
          correlationId: 'c',
        },
        alice,
      );
    await delegate('warm');
    sent = 0;
    await delegate('measured');
    expect(sent).toBeLessThanOrEqual(12);
    await db.close();
  });

  it('runs, checkpoints, survives a restart and completes on the timer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentropy-pg-rt-'));
    const clock = new FakeClock('2026-11-05T00:00:00.000Z');
    const first = app(dir, clock);
    const inst = await first.createInstance(
      {
        definition: { id: 'sleeper', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'i1',
      },
      alice,
    );
    const task = await first.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k1',
        correlationId: 'c1',
      },
      alice,
    );
    await first.runUntilIdle();
    expect((await first.getTask(task.taskId, alice)).status).toBe('waiting');
    await first.store.close();

    clock.advanceBy(60 * 60 * 1000);
    const second = app(dir, clock);
    await second.runUntilIdle();
    const done = await second.getTask(task.taskId, alice);
    expect(done.status).toBe('completed');
    expect(await second.getResult(task.taskId, alice)).toEqual({
      resumedFrom: { step: 1 },
    });
    expect(await second.auditLog.verify('t-1', ops)).toMatchObject({
      ok: true,
    });
    await second.store.close();
  });
});
