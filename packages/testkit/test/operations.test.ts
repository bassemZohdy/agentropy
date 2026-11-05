// TASK-026.5: operations — provider failover rules (D-04), validated operational limits (D-05) and the isolation
// guarantee (N-02).
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type ToolDescriptor,
  type TrustedPrincipal,
} from '@agentropy/core';
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
import { FakeAudit, FakePolicy } from '../src/index.js';

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
