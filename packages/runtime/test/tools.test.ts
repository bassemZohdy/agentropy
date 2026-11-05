// CT-TOOL: Tool v1 conformance and the negative security matrix (T-01, T-02, T-03, N-01).
import {
  isAgentropyError,
  type AuditEvent,
  type PolicyDecisionPoint,
  type ToolDescriptor,
  type ToolInvocationContext,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  DefaultToolExecutor,
  DirectToolProvider,
  InMemoryToolRegistry,
  LoopbackJsonRpcToolProvider,
  ToolProviderRegistry,
  ToolUseCapability,
  deriveIdempotencyKey,
  type LoopbackRequest,
} from '../src/tools.js';

const admin: TrustedPrincipal = { id: 'admin', type: 'user', tenantId: 't-1' };
const agent: TrustedPrincipal = {
  id: 'inst-1',
  type: 'agent',
  tenantId: 't-1',
  delegatedAuthorityRef: 'grant-1',
};

const payout: ToolDescriptor = {
  id: 'finance.payout',
  version: '1.0.0',
  description: 'Pay out an approved expense',
  inputSchema: {
    type: 'object',
    properties: { amount: { type: 'number', minimum: 0 } },
    required: ['amount'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { paymentId: { type: 'string' } },
    required: ['paymentId'],
  },
  effect: 'external',
  idempotency: 'keyed',
  permission: 'tool:finance.payout:call',
};
const quote: ToolDescriptor = {
  ...payout,
  id: 'finance.quote',
  effect: 'read',
  idempotency: 'idempotent',
  permission: 'tool:finance.quote:call',
  outputSchema: undefined,
  inputSchema: true,
};

class Policy implements PolicyDecisionPoint {
  denied = new Set<string>();
  down = false;
  calls = 0;
  async decide(req: { action: string }) {
    this.calls++;
    if (this.down) throw new Error('pdp down');
    return this.denied.has(req.action)
      ? ({ effect: 'deny' } as const)
      : ({ effect: 'allow' } as const);
  }
}
class Audit {
  events: AuditEvent[] = [];
  failing = false;
  async record(e: AuditEvent) {
    if (this.failing) throw new Error('disk full');
    this.events.push(e);
  }
}

function setup() {
  const pdp = new Policy();
  const audit = new Audit();
  const security = { pdp, audit, now: () => '2026-11-05T00:00:00.000Z' };
  const registry = new InMemoryToolRegistry(
    security,
    (_d, p) => p.publisher === 'acme',
  );
  const payments = new Map<string, string>();
  let effects = 0;
  const pay = (input: unknown, ctx: ToolInvocationContext) => {
    // A keyed provider: the same idempotency key returns the original effect.
    const key = ctx.idempotencyKey!;
    if (!payments.has(key)) {
      effects++;
      payments.set(key, `pay-${effects}`);
    }
    void input;
    return { paymentId: payments.get(key)! };
  };
  const direct = new DirectToolProvider({
    pay,
    quote: () => ({ price: 99 }),
    slow: () => new Promise(() => {}),
    boom: () => Promise.reject(new Error('secret=xyz')),
  });
  const wire: LoopbackRequest[] = [];
  const loopback = new LoopbackJsonRpcToolProvider(async (raw) => {
    const req = JSON.parse(raw) as LoopbackRequest;
    wire.push(req);
    return JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: pay(req.params.arguments, {
        idempotencyKey: req.params.idempotencyKey,
      } as ToolInvocationContext),
    });
  });
  const providers = new ToolProviderRegistry();
  providers.register(direct);
  providers.register(loopback);
  const executor = new DefaultToolExecutor({
    ...security,
    registry,
    providers,
    defaultTimeoutMs: 50,
  });
  return {
    pdp,
    audit,
    registry,
    providers,
    executor,
    wire,
    effects: () => effects,
  };
}

const bindings = (d: ToolDescriptor, fn: string) => [
  {
    bindingId: 'direct',
    toolId: d.id,
    toolVersion: d.version,
    providerId: 'direct',
    providerVersion: '1.0.0',
    config: { function: fn },
    default: true,
  },
  {
    bindingId: 'loopback',
    toolId: d.id,
    toolVersion: d.version,
    providerId: 'loopback',
    providerVersion: '1.0.0',
    config: { method: d.id },
  },
];

const ctx = (
  over: Partial<ToolInvocationContext & { stepKey?: string }> = {},
) => ({
  tenantId: 't-1',
  taskId: 'task-1',
  executionId: 'exec-1',
  principal: agent,
  signal: new AbortController().signal,
  stepKey: 'payout',
  ...over,
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no-error';
  } catch (err) {
    return isAgentropyError(err) ? err.code : `non-agentropy: ${String(err)}`;
  }
}

async function activePayout(s: ReturnType<typeof setup>) {
  const rec = await s.registry.register(
    payout,
    bindings(payout, 'pay'),
    { publisher: 'acme', source: 'test' },
    admin,
  );
  await s.registry.activate({ id: payout.id, version: payout.version }, admin);
  const pin = (bindingId: string) => ({
    toolId: payout.id,
    toolVersion: payout.version,
    bindingId,
    providerId: bindingId,
    providerVersion: '1.0.0',
    digest: rec.provenance.digest,
  });
  return pin;
}

describe('tool lifecycle governance (CT-TOOL)', () => {
  it('registration is immutable and audited; identical re-registration is a no-op', async () => {
    const s = setup();
    const a = await s.registry.register(
      payout,
      bindings(payout, 'pay'),
      { publisher: 'acme', source: 'test' },
      admin,
    );
    expect(a).toMatchObject({
      status: 'registered',
      provenance: { verified: true },
    });
    expect(
      await s.registry.register(
        payout,
        bindings(payout, 'pay'),
        { publisher: 'acme', source: 'test' },
        admin,
      ),
    ).toEqual(a);
    expect(
      await code(
        s.registry.register(
          { ...payout, description: 'changed' },
          bindings(payout, 'pay'),
          { publisher: 'acme', source: 'test' },
          admin,
        ),
      ),
    ).toBe('InvalidConfiguration');
    expect(s.audit.events.map((e) => e.type)).toEqual(['tool.register']);
  });

  it('discovery-only tools cannot be invoked', async () => {
    const s = setup();
    const rec = await s.registry.register(
      payout,
      bindings(payout, 'pay'),
      { publisher: 'acme', source: 'test' },
      admin,
    );
    expect(
      (await s.registry.discover({ text: 'payout' }, agent)).map((d) => d.id),
    ).toEqual(['finance.payout']);
    const pin = {
      toolId: payout.id,
      toolVersion: '1.0.0',
      bindingId: 'direct',
      providerId: 'direct',
      providerVersion: '1.0.0',
      digest: rec.provenance.digest,
    };
    expect(await code(s.executor.invoke(pin, { amount: 1 }, ctx()))).toBe(
      'PermissionDenied',
    );
    expect(s.effects()).toBe(0);
  });

  it('unverified tools cannot be activated; unauthorized activation is denied; PDP outage fails closed', async () => {
    const s = setup();
    await s.registry.register(
      payout,
      bindings(payout, 'pay'),
      { publisher: 'evil', source: 'manifest' },
      admin,
    );
    expect(
      await code(
        s.registry.activate({ id: payout.id, version: '1.0.0' }, admin),
      ),
    ).toBe('PermissionDenied');
    const s2 = setup();
    await s2.registry.register(
      payout,
      bindings(payout, 'pay'),
      { publisher: 'acme', source: 'test' },
      admin,
    );
    s2.pdp.denied.add('tool-admin:activate');
    expect(
      await code(
        s2.registry.activate({ id: payout.id, version: '1.0.0' }, admin),
      ),
    ).toBe('PermissionDenied');
    s2.pdp.denied.clear();
    s2.pdp.down = true;
    expect(
      await code(
        s2.registry.activate({ id: payout.id, version: '1.0.0' }, admin),
      ),
    ).toBe('PolicyDecisionUnavailable');
    expect(s2.registry.get({ id: payout.id, version: '1.0.0' })!.status).toBe(
      'registered',
    );
  });

  it('suspended and revoked tools are denied at invocation even for already-pinned tasks', async () => {
    const s = setup();
    const pin = await activePayout(s);
    await s.registry.suspend({ id: payout.id, version: '1.0.0' }, admin);
    expect(
      await code(s.executor.invoke(pin('direct'), { amount: 1 }, ctx())),
    ).toBe('PermissionDenied');
    await s.registry.activate({ id: payout.id, version: '1.0.0' }, admin);
    await s.registry.revoke({ id: payout.id, version: '1.0.0' }, admin);
    expect(
      await code(s.executor.invoke(pin('direct'), { amount: 1 }, ctx())),
    ).toBe('PermissionDenied');
    expect(
      await code(
        s.registry.activate({ id: payout.id, version: '1.0.0' }, admin),
      ),
    ).toBe('InvalidState');
    expect(s.effects()).toBe(0);
  });
});

describe('tool invocation (CT-TOOL)', () => {
  it('the same logical tool through two bindings gives the same result without agent code change', async () => {
    const s = setup();
    const pin = await activePayout(s);
    const viaDirect = await s.executor.invoke(
      pin('direct'),
      { amount: 42 },
      ctx({ stepKey: 'a' }),
    );
    const viaLoopback = await s.executor.invoke(
      pin('loopback'),
      { amount: 42 },
      ctx({ stepKey: 'b' }),
    );
    expect(viaDirect).toEqual({ paymentId: 'pay-1' });
    expect(viaLoopback).toEqual({ paymentId: 'pay-2' });
    expect(s.wire[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'finance.payout',
      params: { arguments: { amount: 42 } },
    });
  });

  it('a replayed step reuses the derived idempotency key, so a keyed provider applies the effect once', async () => {
    const s = setup();
    const pin = await activePayout(s);
    const first = await s.executor.invoke(
      pin('loopback'),
      { amount: 5 },
      ctx(),
    );
    const replay = await s.executor.invoke(
      pin('loopback'),
      { amount: 5 },
      ctx({ executionId: 'exec-2' }),
    );
    expect(replay).toEqual(first);
    expect(s.effects()).toBe(1);
    expect(s.wire[0]!.params.idempotencyKey).toBe(
      deriveIdempotencyKey(
        't-1',
        'task-1',
        'tool-use',
        'call:finance.payout',
        'payout',
      ),
    );
  });

  it('an external tool without a step key is rejected before dispatch (AC-16 invocation part)', async () => {
    const s = setup();
    const pin = await activePayout(s);
    expect(
      await code(
        s.executor.invoke(
          pin('direct'),
          { amount: 1 },
          ctx({ stepKey: undefined }),
        ),
      ),
    ).toBe('SchemaViolation');
    expect(s.effects()).toBe(0);
  });

  it('input and output are schema-validated', async () => {
    const s = setup();
    const pin = await activePayout(s);
    expect(
      await code(s.executor.invoke(pin('direct'), { amount: -1 }, ctx())),
    ).toBe('SchemaViolation');
    expect(s.effects()).toBe(0);
    const bad: ToolDescriptor = {
      ...payout,
      id: 'bad.output',
      permission: 'tool:bad.output:call',
    };
    const rec = await s.registry.register(
      bad,
      bindings(bad, 'quote'),
      { publisher: 'acme', source: 'test' },
      admin,
    );
    await s.registry.activate({ id: bad.id, version: '1.0.0' }, admin);
    const pin2 = {
      toolId: bad.id,
      toolVersion: '1.0.0',
      bindingId: 'direct',
      providerId: 'direct',
      providerVersion: '1.0.0',
      digest: rec.provenance.digest,
    };
    expect(await code(s.executor.invoke(pin2, { amount: 1 }, ctx()))).toBe(
      'SchemaViolation',
    );
  });
});

describe('negative security matrix (T-02, N-01)', () => {
  it('a spoofed tenant is rejected without consulting the PDP', async () => {
    const s = setup();
    const pin = await activePayout(s);
    const calls = s.pdp.calls;
    expect(
      await code(
        s.executor.invoke(
          pin('direct'),
          { amount: 1 },
          ctx({ principal: { ...agent, tenantId: 't-2' } }),
        ),
      ),
    ).toBe('TenantMismatch');
    expect(s.pdp.calls).toBe(calls);
  });

  it('every invocation takes a fresh decision: a revoked grant is denied after a prior allow (no stale Allow)', async () => {
    const s = setup();
    const pin = await activePayout(s);
    await s.executor.invoke(
      pin('direct'),
      { amount: 1 },
      ctx({ stepKey: 'one' }),
    );
    s.pdp.denied.add('tool:finance.payout:call');
    expect(
      await code(
        s.executor.invoke(
          pin('direct'),
          { amount: 1 },
          ctx({ stepKey: 'two' }),
        ),
      ),
    ).toBe('PermissionDenied');
    expect(s.effects()).toBe(1);
  });

  it('a PDP outage at invocation fails closed with no effect', async () => {
    const s = setup();
    const pin = await activePayout(s);
    s.pdp.down = true;
    expect(
      await code(s.executor.invoke(pin('direct'), { amount: 1 }, ctx())),
    ).toBe('PolicyDecisionUnavailable');
    expect(s.effects()).toBe(0);
  });

  it('an audit intent failure prevents dispatch (AuditCommitUnavailable)', async () => {
    const s = setup();
    const pin = await activePayout(s);
    s.audit.failing = true;
    expect(
      await code(s.executor.invoke(pin('direct'), { amount: 1 }, ctx())),
    ).toBe('AuditCommitUnavailable');
    expect(s.effects()).toBe(0);
  });

  it('audit records name the logical tool and the physical binding, never payloads', async () => {
    const s = setup();
    const pin = await activePayout(s);
    await s.executor.invoke(pin('loopback'), { amount: 77 }, ctx());
    const ev = s.audit.events.at(-1)!;
    expect(ev).toMatchObject({
      type: 'tool.invoke',
      resource: { id: 'finance.payout' },
      details: {
        bindingId: 'loopback',
        providerId: 'loopback',
        toolVersion: '1.0.0',
      },
    });
    expect(JSON.stringify(ev)).not.toContain('77');
  });

  it('a changed or removed pinned tool is IncompatibleVersion, not a silent swap', async () => {
    const s = setup();
    const pin = await activePayout(s);
    expect(
      await code(
        s.executor.invoke(
          { ...pin('direct'), digest: 'sha256:other' },
          { amount: 1 },
          ctx(),
        ),
      ),
    ).toBe('IncompatibleVersion');
    expect(
      await code(
        s.executor.invoke(
          { ...pin('direct'), bindingId: 'gone' },
          { amount: 1 },
          ctx(),
        ),
      ),
    ).toBe('IncompatibleVersion');
  });

  it('provider failures and timeouts map to typed outcomes without leaking provider text', async () => {
    const s = setup();
    for (const [d, fn] of [
      [{ ...quote, id: 'slow.read', permission: 'p:slow.read' }, 'slow'],
      [
        {
          ...payout,
          id: 'slow.write',
          permission: 'p:slow.write',
          outputSchema: undefined,
        },
        'slow',
      ],
      [{ ...quote, id: 'boom.read', permission: 'p:boom.read' }, 'boom'],
    ] as [ToolDescriptor, string][]) {
      await s.registry.register(
        d,
        bindings(d, fn),
        { publisher: 'acme', source: 'test' },
        admin,
      );
      await s.registry.activate({ id: d.id, version: d.version }, admin);
    }
    const pin = (id: string) => ({
      toolId: id,
      toolVersion: '1.0.0',
      bindingId: 'direct',
      providerId: 'direct',
      providerVersion: '1.0.0',
      digest: s.registry.get({ id, version: '1.0.0' })!.provenance.digest,
    });
    expect(await code(s.executor.invoke(pin('slow.read'), {}, ctx()))).toBe(
      'Timeout',
    );
    expect(
      await code(s.executor.invoke(pin('slow.write'), { amount: 1 }, ctx())),
    ).toBe('UnknownAcceptance');
    try {
      await s.executor.invoke(pin('boom.read'), {}, ctx());
      expect.fail('expected ProviderUnavailable');
    } catch (err) {
      expect(isAgentropyError(err, 'ProviderUnavailable')).toBe(true);
      expect(
        JSON.stringify((err as { toJSON(): unknown }).toJSON()),
      ).not.toContain('xyz');
    }
  });

  it('credentials are resolved just in time and never appear in pins, records or errors', async () => {
    const s = setup();
    const seen: unknown[] = [];
    const d: ToolDescriptor = {
      ...quote,
      id: 'secure.read',
      permission: 'p:secure.read',
    };
    const providers = new ToolProviderRegistry();
    providers.register(
      new DirectToolProvider({
        read: (_i, c) => (seen.push(c.credential), { ok: true }),
      }),
    );
    const executor = new DefaultToolExecutor({
      pdp: s.pdp,
      audit: s.audit,
      now: () => 'now',
      registry: s.registry,
      providers,
      credentials: { resolve: async (ref) => `token-for-${ref}` },
    });
    const rec = await s.registry.register(
      d,
      [
        {
          bindingId: 'direct',
          toolId: d.id,
          toolVersion: '1.0.0',
          providerId: 'direct',
          providerVersion: '1.0.0',
          config: { function: 'read' },
          credentialRef: 'vault:quote',
        },
      ],
      { publisher: 'acme', source: 'test' },
      admin,
    );
    await s.registry.activate({ id: d.id, version: '1.0.0' }, admin);
    const pin = {
      toolId: d.id,
      toolVersion: '1.0.0',
      bindingId: 'direct',
      providerId: 'direct',
      providerVersion: '1.0.0',
      digest: rec.provenance.digest,
    };
    await executor.invoke(pin, {}, ctx());
    expect(seen).toEqual(['token-for-vault:quote']);
    expect(
      JSON.stringify([
        pin,
        s.registry.get({ id: d.id, version: '1.0.0' }),
        s.audit.events,
      ]),
    ).not.toContain('token-for');
  });
});

describe('tool-use capability surface', () => {
  it('lists only pinned tools and refuses unpinned ones', async () => {
    const s = setup();
    const pin = await activePayout(s);
    const cap = new ToolUseCapability(s.executor, s.registry, [pin('direct')]);
    expect(cap.listTools().tools.map((t) => t.id)).toEqual(['finance.payout']);
    expect(
      await cap.call({ toolId: 'finance.payout', input: { amount: 3 } }, ctx()),
    ).toEqual({ output: { paymentId: 'pay-1' } });
    expect(
      await code(cap.call({ toolId: 'finance.quote', input: {} }, ctx())),
    ).toBe('CapabilityNotDeclared');
  });
});
