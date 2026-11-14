// TASK-026.5: operations — provider failover rules (D-04), validated operational limits (D-05) and the isolation
// guarantee (N-02).
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type ToolDescriptor,
  type TrustedPrincipal,
} from '@agentropy/core';
import type { Store, StoreTx } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  DefaultToolExecutor,
  DirectToolProvider,
  InMemoryToolRegistry,
  ToolProviderRegistry,
  createLocalApp,
  resolveLimits,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeAudit, FakeClock, FakePolicy } from '../src/index.js';

const admin: TrustedPrincipal = { id: 'admin', type: 'user', tenantId: 't-1' };
const agent: TrustedPrincipal = { id: 'inst', type: 'agent', tenantId: 't-1' };

describe('D-04: provider failover', () => {
  function setup() {
    const security = {
      pdp: new FakePolicy(),
      audit: new FakeAudit(),
      now: () => '2026-11-05T00:00:00.000Z',
    };
    const registry = new InMemoryToolRegistry(security, () => true);
    const calls: string[] = [];
    let effects = 0;
    const primary = new DirectToolProvider({
      down: () => {
        calls.push('primary');
        throw new Error('connection refused');
      },
    });
    const backup = new (class extends DirectToolProvider {
      override readonly id = 'loopback';
    })({
      'quote.read': () => {
        calls.push('backup');
        return { price: 42 };
      },
      'pay.write': () => {
        calls.push('backup');
        effects++;
        return { paymentId: 'p' };
      },
    });
    const providers = new ToolProviderRegistry();
    providers.register(primary);
    providers.register(backup);
    const executor = new DefaultToolExecutor({
      ...security,
      registry,
      providers,
    });
    const tool = async (d: ToolDescriptor, fallback: boolean) => {
      const rec = await registry.register(
        d,
        [
          {
            bindingId: 'direct',
            toolId: d.id,
            toolVersion: d.version,
            providerId: 'direct',
            providerVersion: '1.0.0',
            config: {
              function: 'down',
              ...(fallback ? { fallbackBindings: ['loopback'] } : {}),
            },
            default: true,
          },
          {
            bindingId: 'loopback',
            toolId: d.id,
            toolVersion: d.version,
            providerId: 'loopback',
            providerVersion: '1.0.0',
            config: { function: d.id },
          },
        ],
        { publisher: 'acme', source: 'test' },
        admin,
      );
      await registry.activate({ id: d.id, version: d.version }, admin);
      return {
        toolId: d.id,
        toolVersion: d.version,
        bindingId: 'direct',
        providerId: 'direct',
        providerVersion: '1.0.0',
        digest: rec.provenance.digest,
      };
    };
    const ctx = () => ({
      tenantId: 't-1',
      taskId: 'task',
      executionId: 'e',
      principal: agent,
      signal: new AbortController().signal,
      stepKey: 's',
    });
    return { executor, tool, ctx, calls, effects: () => effects };
  }

  it('a read-only tool fails over to the bindings its pinned binding lists, in order', async () => {
    const s = setup();
    const pin = await s.tool(
      {
        id: 'quote.read',
        version: '1.0.0',
        description: 'q',
        inputSchema: true,
        effect: 'read',
        idempotency: 'idempotent',
        permission: 'p:quote',
      },
      true,
    );
    expect(await s.executor.invoke(pin, {}, s.ctx())).toEqual({ price: 42 });
    expect(s.calls).toEqual(['primary', 'backup']);
  });

  it('without an opt-in, or for a tool with effects, an outage is surfaced instead of switching providers', async () => {
    const s = setup();
    const read = await s.tool(
      {
        id: 'quote.read',
        version: '1.0.0',
        description: 'q',
        inputSchema: true,
        effect: 'read',
        idempotency: 'idempotent',
        permission: 'p:quote',
      },
      false,
    );
    expect(await code(s.executor.invoke(read, {}, s.ctx()))).toBe(
      'ProviderUnavailable',
    );
    const write = await s.tool(
      {
        id: 'pay.write',
        version: '1.0.0',
        description: 'p',
        inputSchema: true,
        effect: 'external',
        idempotency: 'keyed',
        permission: 'p:pay',
      },
      true,
    );
    // For a tool with effects the outcome of the failed call is unknown, so it is reported as such and never retried
    // on another provider.
    expect(await code(s.executor.invoke(write, {}, s.ctx()))).toBe(
      'UnknownAcceptance',
    );
    expect(s.effects()).toBe(0);
  });
});

describe('D-05: operational limits', () => {
  it('defaults are documented and the app exposes its effective limits', () => {
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      limits: { maxFanOut: 50, gateRetry: { maxAttempts: 3 } as never },
      runtime: { poolSize: 8 },
    });
    expect(app.limits).toMatchObject({
      ...DEFAULT_LIMITS,
      poolSize: 8,
      maxFanOut: 50,
      gateRetry: { initialMs: 1_000, maxMs: 300_000, maxAttempts: 3 },
    });
    expect(Object.isFrozen(app.limits)).toBe(true);
  });

  it('invalid limits fail fast with InvalidConfiguration naming the field', async () => {
    for (const [over, field] of [
      [{ poolSize: 0 }, 'poolSize'],
      [{ leaseMs: 1.5 }, 'leaseMs'],
      [{ maxCheckpointBytes: 10 }, 'maxCheckpointBytes'],
      [{ mailboxLimit: -1 }, 'mailboxLimit'],
      [
        { gateRetry: { initialMs: 10, maxMs: 5, maxAttempts: 1 } },
        'gateRetry.maxMs',
      ],
      [{ cancelGraceMs: 120_000, leaseMs: 60_000 }, 'cancelGraceMs'],
    ] as const) {
      let err: unknown;
      try {
        resolveLimits(over as never);
      } catch (e) {
        err = e;
      }
      expect((err as { code: string }).code).toBe('InvalidConfiguration');
      expect((err as { details: { field: string } }).details.field).toBe(field);
    }
    expect(
      await code(() =>
        createLocalApp({
          store: sqliteTempStore(),
          pdp: new FakePolicy(),
          limits: { maxDepth: 0 },
        }),
      ),
    ).toBe('InvalidConfiguration');
  });

  it('configured delegation limits are enforced', async () => {
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
      limits: { maxFanOut: 1 },
    });
    let target = '';
    app.define(def('leaf'), {
      handle: async () => ({ kind: 'completed', output: 1 }),
    });
    app.define(
      def('fan', {
        capabilities: [{ id: 'delegation', versionRange: '^1.0.0' }],
      }),
      {
        handle: async (_inv, ctx) => {
          for (const k of ['a', 'b'])
            await ctx.capabilities.invoke(
              'delegation',
              'delegate',
              { target: { instanceId: target }, input: {} },
              { stepKey: k },
            );
          return { kind: 'completed', output: null };
        },
      },
    );
    const alice: TrustedPrincipal = {
      id: 'alice',
      type: 'user',
      tenantId: 't-1',
    };
    target = (
      await app.createInstance(
        {
          definition: { id: 'leaf', version: '1.0.0' },
          ownerId: 'alice',
          idempotencyKey: 'l',
        },
        alice,
      )
    ).id;
    const fan = await app.createInstance(
      {
        definition: { id: 'fan', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'f',
      },
      alice,
    );
    const t = await app.delegate(
      {
        target: { instanceId: fan.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'k',
      },
      alice,
    );
    await app.runUntilIdle();
    expect((await app.getTask(t.taskId, alice)).outcome?.code).toBe(
      'FanOutExceeded',
    );
  });
});

describe('N-02: isolation guarantee', () => {
  it('the local runtime provides logical isolation; a definition requiring process or sandbox isolation is refused', async () => {
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
    });
    const alice: TrustedPrincipal = {
      id: 'alice',
      type: 'user',
      tenantId: 't-1',
    };
    for (const level of ['logical', 'sandbox'] as const)
      app.define(
        def(`iso-${level}`, {
          runtimeRequirements: {
            guarantees: [{ id: 'isolation', versionRange: '^1.0.0', level }],
          },
        }),
        { handle: async () => ({ kind: 'completed', output: level }) },
      );
    const run = async (level: string) => {
      const inst = await app.createInstance(
        {
          definition: { id: `iso-${level}`, version: '1.0.0' },
          ownerId: 'alice',
          idempotencyKey: level,
        },
        alice,
      );
      return app.delegate(
        {
          target: { instanceId: inst.id },
          input: {},
          idempotencyKey: level,
          correlationId: level,
        },
        alice,
      );
    };
    const ok = await run('logical');
    expect(ok.snapshot?.bindings ?? []).toBeDefined();
    expect(await code(run('sandbox'))).toBe('GuaranteeUnavailable');
  });
});

function def(id: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    version: '1.0.0',
    displayName: id,
    profile: { id: 'task', version: '1.0.0' },
    implementation: {
      providerId: 'native-ts',
      providerVersion: '1.0.0',
      artifact: { id, version: '1.0.0' },
    },
    inputSchema: true,
    runtimeRequirements: { guarantees: [] },
    policyRef: { id: 'default', version: '1.0.0' },
    ...over,
  };
}

describe('compaction covers every collection (FEAT-040.1)', () => {
  it('removes the standing state of an ended task once, keeps the task answerable, and skips it afterwards', async () => {
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      now: clock.iso,
      profiles: BUILTIN_PROFILES,
    });
    const alice: TrustedPrincipal = {
      id: 'alice',
      type: 'user',
      tenantId: 't-1',
    };
    const ops: TrustedPrincipal = {
      id: 'ops',
      type: 'service',
      tenantId: 't-1',
    };
    app.define(
      {
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
        capabilities: [{ id: 'human-input', versionRange: '^1.0.0' }],
      },
      {
        handle: async (inv, ctx) => {
          if (inv.activation > 1) return { kind: 'completed', output: 'done' };
          await ctx.capabilities.invoke(
            'notification',
            'notify',
            { severity: 'normal', title: 't', body: 'b' },
            { stepKey: 'n1' },
          );
          await ctx.capabilities.invoke(
            'human-input',
            'requestAction',
            {
              kind: 'text',
              prompt: 'q',
              inputSchema: { type: 'string' },
              assignees: { principalIds: ['alice'] },
              onExpiry: 'fail-task',
            },
            { stepKey: 'ask' },
          );
          return {
            kind: 'waiting',
            wakeup: {
              anyOf: [{ kind: 'timer', at: '2026-11-06T00:00:00.000Z' }],
            },
            checkpoint: { a: 1 },
          };
        },
      },
    );
    const inst = await app.createInstance(
      {
        definition: { id: 'worker', version: '1.0.0' },
        ownerId: alice.id,
        idempotencyKey: 'i',
      },
      alice,
    );
    const t = await app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'k',
      },
      alice,
    );
    await app.runUntilIdle();
    expect((await app.getTask(t.taskId, alice)).status).toBe('completed');
    const count = async (
      c:
        | 'effects'
        | 'checkpoints'
        | 'humanActions'
        | 'executions'
        | 'wakeups'
        | 'usage'
        | 'pushConfigs'
        | 'subscriptions',
    ) => (await app.store.transaction((tx) => tx.find(c, {}))).length;
    expect(await count('effects')).toBeGreaterThan(0);
    expect(await count('checkpoints')).toBe(1);
    expect(await count('humanActions')).toBe(1);

    clock.advanceBy(60_000);
    const first = await app.compact(1_000, ops);
    expect(first).toMatchObject({
      tasks: 1,
      checkpoints: 1,
      humanActions: 1,
      idempotency: 1,
    });
    expect(first.effects).toBeGreaterThan(0);
    expect(first.executions).toBeGreaterThanOrEqual(2);
    expect(first.wakeups).toBeGreaterThan(0);
    expect(first.outbox).toBeGreaterThan(0);
    expect(first.inbox).toBeGreaterThan(0);
    for (const c of [
      'effects',
      'checkpoints',
      'humanActions',
      'executions',
      'wakeups',
    ] as const)
      expect(await count(c)).toBe(0);
    // The task is still the system of record; a second run has nothing left to do.
    expect(await app.getResult(t.taskId, alice)).toBe('done');
    const second = await app.compact(1_000, ops);
    expect(second.tasks).toBe(0);
    expect(second.effects + second.executions + second.wakeups).toBe(0);
  });
});

describe('compaction reads what is due (TASK-066)', () => {
  const alice: TrustedPrincipal = {
    id: 'alice',
    type: 'user',
    tenantId: 't-1',
  };
  const ops: TrustedPrincipal = { id: 'ops', type: 'service', tenantId: 't-1' };

  /** Counts the documents each `find` returns per collection; `retry` runs every writing transaction twice. */
  function wrap(retry = false) {
    const inner = sqliteTempStore();
    const read: Record<string, number> = {};
    const store: Store = {
      durability: inner.durability,
      close: () => inner.close(),
      transaction: async (fn) => {
        const conflict = new Error('serialization conflict');
        let retried = false;
        for (;;) {
          let wrote = false;
          try {
            return await inner.transaction(async (tx) => {
              const r = await fn({
                ...tx,
                find: async (c, o) => {
                  const rows = await tx.find(c, o);
                  read[c] = (read[c] ?? 0) + rows.length;
                  return rows;
                },
                get: (c, id) => tx.get(c, id),
                insert: (c, id, v) => tx.insert(c, id, v),
                update: (c, id, rev, v) => {
                  wrote = true;
                  return tx.update(c, id, rev, v);
                },
                remove: (c, id, rev) => {
                  wrote = true;
                  return tx.remove(c, id, rev);
                },
              } as StoreTx);
              // A serialization conflict at commit: the callback runs again on a fresh snapshot.
              if (retry && wrote && !retried) {
                retried = true;
                throw conflict;
              }
              return r;
            });
          } catch (err) {
            if (err !== conflict) throw err;
          }
        }
      },
    };
    return { store, read };
  }

  async function app(store: Store, tasks: number) {
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const a = createLocalApp({
      store,
      pdp: new FakePolicy(),
      now: clock.iso,
      profiles: BUILTIN_PROFILES,
    });
    a.define(
      {
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
      },
      { handle: async () => ({ kind: 'completed', output: 'done' }) },
    );
    const inst = await a.createInstance(
      {
        definition: { id: 'worker', version: '1.0.0' },
        ownerId: alice.id,
        idempotencyKey: 'i',
      },
      alice,
    );
    for (let i = 0; i < tasks; i++)
      await a.delegate(
        {
          target: { instanceId: inst.id },
          input: {},
          idempotencyKey: `k${i}`,
          correlationId: `k${i}`,
        },
        alice,
      );
    await a.runUntilIdle();
    clock.advanceBy(60_000);
    return { a, clock };
  }

  it('TASK-066: a run over already compacted tasks reads none of them', async () => {
    const { store, read } = wrap();
    const { a } = await app(store, 12);
    const first = await a.compact(1_000, ops);
    expect(first.tasks).toBe(12);
    for (const k of Object.keys(read)) delete read[k];
    const second = await a.compact(1_000, ops);
    expect(second.tasks).toBe(0);
    expect(read['tasks'] ?? 0).toBe(0);
    expect(read['inboundEvents'] ?? 0).toBe(0);
    expect(read['memories'] ?? 0).toBe(0);
  });

  it('TASK-066: retainMs must be a non-negative number', async () => {
    const { a } = await app(sqliteTempStore(), 1);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1000', null])
      expect(await code(a.compact(bad as never, ops))).toBe('SchemaViolation');
    expect((await a.compact(1_000, ops)).tasks).toBe(1);
    expect((await a.compact(0, ops)).tasks).toBe(0);
  });

  it('TASK-066: counts are not doubled when a transaction runs again', async () => {
    const { store } = wrap(true);
    const { a } = await app(store, 3);
    const first = await a.compact(1_000, ops);
    expect(first.tasks).toBe(3);
    expect(first.idempotency).toBe(3);
  });
});
