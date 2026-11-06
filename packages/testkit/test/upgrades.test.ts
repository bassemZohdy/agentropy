// FEAT-028.3: upgrades (M3-03, D-07) — audited instance definition upgrade and rollback that never touches
// accepted tasks, version-usage reporting for safe removal, checkpoint codec versions across a redeploy, and
// additive store schema evolution on SQLite and PostgreSQL (PGlite).
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { createLocalApp, type LocalApp } from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { SqliteStore } from '../../store-sqlite/src/index.js';
import { PostgresStore } from '../../store-postgres/src/index.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
const ops: TrustedPrincipal = { id: 'ops', type: 'service', tenantId: 't-1' };

const def = (version: string): AgentDefinition => ({
  id: 'summarizer',
  version,
  displayName: 'summarizer',
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'summarizer', version },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
});

const WAKE = '2026-11-06T01:00:00.000Z';

/** Waits once on a timer when asked to, then completes with its version label. */
const versioned = (label: string): Agent => ({
  handle: async (inv) =>
    (inv.input as { wait?: boolean }).wait && inv.activation === 1
      ? {
          kind: 'waiting',
          wakeup: { anyOf: [{ kind: 'timer', at: WAKE }] },
          checkpoint: null,
        }
      : { kind: 'completed', output: label },
});

async function storePath() {
  return join(await mkdtemp(join(tmpdir(), 'agentropy-up-')), 'db');
}

describe('instance definition upgrade and rollback (D-07)', () => {
  function setup() {
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const pdp = new FakePolicy();
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp,
      now: clock.iso,
      profiles: BUILTIN_PROFILES,
    });
    app.define(def('1.0.0'), versioned('v1'));
    app.define(def('2.0.0'), versioned('v2'));
    const delegate = (instanceId: string, key: string, wait = false) =>
      app.delegate(
        {
          target: { instanceId },
          input: { wait },
          idempotencyKey: key,
          correlationId: key,
        },
        alice,
      );
    return { app, clock, pdp, delegate };
  }

  it('new tasks use the upgraded version; accepted tasks keep their pin; rollback is the same audited operation', async () => {
    const { app, clock, delegate } = setup();
    const inst = await app.createInstance(
      {
        definition: { id: 'summarizer', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'i',
      },
      alice,
    );
    const pinned = await delegate(inst.id, 'before', true);
    await app.runUntilIdle();
    expect((await app.getTask(pinned.taskId, alice)).status).toBe('waiting');

    const up = await app.upgradeInstance(
      inst.id,
      { version: '2.0.0', expectedRevision: inst.revision },
      alice,
    );
    expect(up.definition).toEqual({ id: 'summarizer', version: '2.0.0' });
    expect(up.previousDefinition).toEqual({
      id: 'summarizer',
      version: '1.0.0',
    });
    expect(await app.versionsInUse('summarizer', ops)).toEqual([
      { version: '1.0.0', instances: 0, activeTasks: 1 },
      { version: '2.0.0', instances: 1, activeTasks: 0 },
    ]);

    const after = await delegate(inst.id, 'after');
    await app.runUntilIdle();
    expect(await app.getResult(after.taskId, alice)).toBe('v2');
    clock.advanceBy(60 * 60 * 1000);
    await app.runUntilIdle();
    expect(await app.getResult(pinned.taskId, alice)).toBe('v1');
    expect(await app.versionsInUse('summarizer', ops)).toEqual([
      { version: '2.0.0', instances: 1, activeTasks: 0 },
    ]);

    const back = await app.upgradeInstance(
      inst.id,
      { version: '1.0.0', expectedRevision: up.revision },
      alice,
    );
    expect(back.definition.version).toBe('1.0.0');
    const rolled = await delegate(inst.id, 'rolled');
    await app.runUntilIdle();
    expect(await app.getResult(rolled.taskId, alice)).toBe('v1');

    const audit = await app.auditLog.query(
      { tenantId: 't-1', type: 'instance.upgrade' },
      ops,
    );
    expect(audit.map((e) => e.details)).toMatchObject([
      { from: '1.0.0', to: '2.0.0', definition: 'summarizer' },
      { from: '2.0.0', to: '1.0.0', definition: 'summarizer' },
    ]);
  });

  it('refuses stale revisions, unregistered versions, other users, denied policy and retired instances', async () => {
    const { app, pdp } = setup();
    const inst = await app.createInstance(
      {
        definition: { id: 'summarizer', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'i',
      },
      alice,
    );
    const upgrade = (version: string, rev: number, who = alice) =>
      code(
        app.upgradeInstance(inst.id, { version, expectedRevision: rev }, who),
      );
    expect(await upgrade('2.0.0', inst.revision + 1)).toBe('StaleRevision');
    expect(await upgrade('9.9.9', inst.revision)).toBe('IncompatibleVersion');
    expect(await upgrade('2.0.0', inst.revision, bob)).toBe('NotFound');
    expect(await code(app.versionsInUse('summarizer', alice))).toBe(
      'PermissionDenied',
    );
    pdp.denied.add('agent:upgrade');
    expect(await upgrade('2.0.0', inst.revision)).toBe('PermissionDenied');
    pdp.denied.clear();
    const retired = await app.retireInstance(inst.id, alice);
    expect(await upgrade('2.0.0', retired.revision)).toBe('InvalidState');
  });
});

describe('checkpoint codec versions across a redeploy (M3-03)', () => {
  const codecDef = def('1.0.0');

  /** First deployment: counts to 1, waits, and stores { count }. */
  const firstDeploy: Agent = {
    handle: async (inv) =>
      inv.activation === 1
        ? {
            kind: 'waiting',
            wakeup: { anyOf: [{ kind: 'timer', at: WAKE }] },
            checkpoint: { count: 1 },
          }
        : { kind: 'completed', output: inv.checkpoint },
  };

  async function redeploy(second: Agent, first: Agent = firstDeploy) {
    const path = await storePath();
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const boot = (agent: Agent): LocalApp => {
      const app = createLocalApp({
        store: new SqliteStore({ path }),
        pdp: new FakePolicy(),
        now: clock.iso,
        profiles: BUILTIN_PROFILES,
      });
      app.define(codecDef, agent);
      return app;
    };
    const a = boot(first);
    const inst = await a.createInstance(
      {
        definition: { id: 'summarizer', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'i',
      },
      alice,
    );
    const task = await a.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
    );
    await a.runUntilIdle();
    await a.store.close();
    clock.advanceBy(60 * 60 * 1000);
    const b = boot(second);
    await b.runUntilIdle();
    const snap = await b.getTask(task.taskId, alice);
    const result =
      snap.status === 'completed'
        ? await b.getResult(task.taskId, alice)
        : undefined;
    await b.store.close();
    return { snap, result };
  }

  it('upgrades an older checkpoint through the codec', async () => {
    const r = await redeploy({
      checkpointCodec: {
        version: 2,
        upgrade: (cp, from) => ({
          total: (cp as { count: number }).count,
          from,
        }),
      },
      handle: async (inv) => ({ kind: 'completed', output: inv.checkpoint }),
    });
    expect(r.result).toEqual({ total: 1, from: 1 });
  });

  it('fails with IncompatibleVersion when no upgrade exists, or the checkpoint is newer than the handler', async () => {
    const noUpgrade = await redeploy({
      checkpointCodec: { version: 2 },
      handle: async () => ({ kind: 'completed', output: 'never' }),
    });
    expect(noUpgrade.snap.status).toBe('failed');
    expect(noUpgrade.snap.outcome?.code).toBe('IncompatibleVersion');

    const downgrade = await redeploy(firstDeploy, {
      ...firstDeploy,
      checkpointCodec: { version: 3 },
    });
    expect(downgrade.snap.status).toBe('failed');
    expect(downgrade.snap.outcome?.code).toBe('IncompatibleVersion');
  });

  it('a throwing upgrade is IncompatibleVersion, not a crash', async () => {
    const r = await redeploy({
      checkpointCodec: {
        version: 2,
        upgrade: () => {
          throw new Error('bad shape');
        },
      },
      handle: async () => ({ kind: 'completed', output: 'never' }),
    });
    expect(r.snap.outcome?.code).toBe('IncompatibleVersion');
  });
});

describe('additive store schema evolution (M3-03)', () => {
  it('SQLite: a missing collection and a missing index column are recreated and backfilled', async () => {
    const path = await storePath();
    const s = new SqliteStore({ path });
    await s.transaction(async (tx) => {
      await tx.insert('tasks', 'parent', { tenantId: 't' });
      await tx.insert('tasks', 'child', {
        tenantId: 't',
        parentTaskId: 'parent',
      });
    });
    await s.close();
    // Simulate a database written by a release without `remoteTasks` and without the `parentTaskId` index.
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE "c_remoteTasks"');
    raw.exec('DROP INDEX "x_tasks_parentTaskId"');
    raw.exec('ALTER TABLE "c_tasks" DROP COLUMN "i_parentTaskId"');
    raw.close();

    const up = new SqliteStore({ path });
    const kids = await up.transaction((tx) =>
      tx.find('tasks', { where: { parentTaskId: 'parent' } }),
    );
    expect(kids.map((d) => d.id)).toEqual(['child']);
    await up.transaction((tx) =>
      tx.insert('remoteTasks', 'r', { tenantId: 't', status: 'created' }),
    );
    await up.close();
  });

  it('PostgreSQL: the same evolution runs under the migration lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentropy-up-pg-'));
    const db = new PGlite(dir);
    const s = new PostgresStore({ client: db });
    await s.transaction(async (tx) => {
      await tx.insert('tasks', 'parent', { tenantId: 't' });
      await tx.insert('tasks', 'child', {
        tenantId: 't',
        parentTaskId: 'parent',
      });
    });
    await db.query('DROP TABLE agentropy."c_remoteTasks"');
    await db.query(
      'ALTER TABLE agentropy."c_tasks" DROP COLUMN "n_parentTaskId", DROP COLUMN "s_parentTaskId"',
    );

    const up = new PostgresStore({ client: db });
    const kids = await up.transaction((tx) =>
      tx.find('tasks', { where: { parentTaskId: 'parent' } }),
    );
    expect(kids.map((d) => d.id)).toEqual(['child']);
    await up.transaction((tx) =>
      tx.insert('remoteTasks', 'r', { tenantId: 't', status: 'created' }),
    );
    await db.close();
  });
});
