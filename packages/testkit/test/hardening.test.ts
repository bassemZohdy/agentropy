// FEAT-028.5: hardening (M3-05, D-24, ADR-0030) — separation of duties and N-of-M approvals for human
// approvals, and a secret canary: a credential value used by a tool never lands in the store, the outbox, the
// audit sink, task errors or telemetry, even when the tool provider puts it in its error message.
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type CredentialProvider,
  type ToolDescriptor,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  DefaultToolExecutor,
  DirectToolProvider,
  InMemoryToolRegistry,
  ToolProviderRegistry,
  createLocalApp,
  openTelemetry,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeAudit, FakeClock, FakePolicy } from '../src/index.js';
import {
  DefaultToolExecutor,
  InMemoryToolRegistry,
  ToolProviderRegistry,
} from '../../runtime/src/index.js';
import * as api from '@opentelemetry/api';
import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace';

const user = (id: string): TrustedPrincipal => ({
  id,
  type: 'user',
  tenantId: 't-1',
});
const alice = user('alice');
const ops: TrustedPrincipal = { id: 'ops', type: 'service', tenantId: 't-1' };

const def = (
  id: string,
  over: Partial<AgentDefinition> = {},
): AgentDefinition => ({
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
});

const approvalSchema = {
  type: 'object',
  properties: { decision: { enum: ['approve', 'reject'] } },
  required: ['decision'],
};

describe('approval enforcement (M3-05)', () => {
  async function setup(request: Record<string, unknown>) {
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
      profiles: BUILTIN_PROFILES,
    });
    const agent: Agent = {
      handle: async (inv, ctx) => {
        if (inv.activation === 1) {
          let requestId: string;
          try {
            ({ requestId } = await ctx.capabilities.invoke<
              unknown,
              { requestId: string }
            >(
              'human-input',
              'requestAction',
              {
                kind: 'approval',
                prompt: 'Release the payment?',
                inputSchema: approvalSchema,
                assignees: { principalIds: ['alice', 'bob', 'carol', 'dan'] },
                onExpiry: 'fail-task',
                ...request,
              },
              { stepKey: 'approval' },
            ));
          } catch (err) {
            return {
              kind: 'completed',
              output: { refused: (err as { code: string }).code },
            };
          }
          return {
            kind: 'waiting',
            wakeup: { anyOf: [{ kind: 'human-action', requestId }] },
            checkpoint: { requestId },
          };
        }
        return { kind: 'completed', output: inv.wakeReason };
      },
    };
    app.define(
      def('payments', {
        capabilities: [{ id: 'human-input', versionRange: '^1.0.0' }],
      }),
      agent,
    );
    const inst = await app.createInstance(
      {
        definition: { id: 'payments', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'i',
      },
      alice,
    );
    // Alice asks for the payment, so she is the requester of the work.
    const task = await app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
    );
    await app.runUntilIdle();
    const decide = async (who: string, decision: 'approve' | 'reject') => {
      const req = await app.getHumanAction(await firstRequest(), user(who));
      return app.provideHumanInput(
        {
          requestId: req.requestId,
          expectedRevision: req.revision,
          input: { decision },
          idempotencyKey: `${who}-${decision}`,
        },
        user(who),
      );
    };
    const firstRequest = async () =>
      (
        await app.store.transaction((tx) =>
          tx.find<{ requestId: string }>('humanActions', {}),
        )
      )[0]!.value.requestId;
    return { app, task, decide };
  }

  it('the requester cannot approve their own work; another assignee can', async () => {
    const s = await setup({});
    expect(await code(s.decide('alice', 'approve'))).toBe('NotAssignee');
    await s.decide('bob', 'approve');
    await s.app.runUntilIdle();
    expect(await s.app.getResult(s.task.taskId, alice)).toMatchObject({
      kind: 'human-action',
      outcome: 'resolved',
      input: { decision: 'approve' },
    });
  });

  it('allowSelfApproval is an explicit per-request opt-out', async () => {
    const s = await setup({ allowSelfApproval: true });
    await s.decide('alice', 'approve');
    await s.app.runUntilIdle();
    expect((await s.app.getTask(s.task.taskId, alice)).status).toBe(
      'completed',
    );
  });

  it('two-person rule: resolves only when two distinct assignees agree; repeats and disagreement do not count', async () => {
    const s = await setup({ requiredApprovals: 2 });
    await s.decide('bob', 'approve');
    await s.decide('bob', 'approve'); // same person again
    await s.decide('carol', 'reject'); // disagreement is recorded, not decisive
    await s.app.runUntilIdle();
    expect((await s.app.getTask(s.task.taskId, alice)).status).toBe('waiting');
    await s.decide('dan', 'approve');
    await s.app.runUntilIdle();
    expect(await s.app.getResult(s.task.taskId, alice)).toMatchObject({
      input: { decision: 'approve' },
    });
    const partial = await s.app.auditLog.query(
      { tenantId: 't-1', type: 'human-action.approve-partial' },
      ops,
    );
    expect(partial.map((e) => e.principalId)).toEqual(['bob', 'bob', 'carol']);
  });

  it('rejects quorum settings outside approvals or out of range', async () => {
    for (const bad of [
      { requiredApprovals: 6 },
      { requiredApprovals: 0 },
      { kind: 'text', requiredApprovals: 2 },
      { kind: 'text', allowSelfApproval: true },
    ]) {
      const s = await setup(bad);
      expect(await s.app.getResult(s.task.taskId, alice)).toEqual({
        refused: 'SchemaViolation',
      });
    }
  });
});

describe('secret canary (M3-05)', () => {
  const SECRET = 'sk-canary-7f3a9c41e2';

  it('a credential never reaches the store, outbox, audit sink, errors or telemetry', async () => {
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const pdp = new FakePolicy();
    const audit = new FakeAudit();
    const spans = new InMemorySpanExporter();
    const telemetry = openTelemetry({
      api,
      tracer: new TracerProvider({
        spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
      }).getTracer('canary'),
    });
    const vault: CredentialProvider = {
      resolve: async () => ({ apiKey: SECRET }),
    };
    const tool: ToolDescriptor = {
      id: 'bank.transfer',
      version: '1.0.0',
      description: 'Transfer',
      inputSchema: true,
      effect: 'external',
      idempotency: 'keyed',
      permission: 'tool:bank.transfer:call',
    };
    const registry = new InMemoryToolRegistry(
      { pdp, audit, now: clock.iso },
      () => true,
    );
    const providers = new ToolProviderRegistry();
    providers.register(
      new DirectToolProvider({
        transfer: (input: unknown, ctx) => {
          const key = (ctx.credential as { apiKey: string }).apiKey;
          if ((input as { fail?: boolean }).fail)
            throw new Error(`upstream rejected key ${key}`);
          return { ok: true, echoedKey: key.length };
        },
      }),
    );
    await registry.register(
      tool,
      [
        {
          bindingId: 'direct',
          toolId: tool.id,
          toolVersion: tool.version,
          providerId: 'direct',
          providerVersion: '1.0.0',
          config: { function: 'transfer' },
          credentialRef: 'bank-api',
          default: true,
        },
      ],
      { publisher: 'acme', source: 'test' },
      alice,
    );
    await registry.activate({ id: tool.id, version: tool.version }, alice);
    const store = sqliteTempStore();
    const app = createLocalApp({
      store,
      pdp,
      audit,
      telemetry,
      now: clock.iso,
      profiles: BUILTIN_PROFILES,
      tools: {
        registry,
        providers,
        executor: new DefaultToolExecutor({
          pdp,
          audit,
          now: clock.iso,
          registry,
          providers,
          credentials: vault,
        }),
      },
    });
    app.define(
      def('mover', {
        capabilities: [{ id: 'tool-use', versionRange: '^1.0.0' }],
        tools: [{ id: tool.id, versionRange: '^1.0.0' }],
      }),
      {
        handle: async (inv, ctx) => {
          const r = await ctx.capabilities.invoke(
            'tool-use',
            'call',
            { toolId: tool.id, input: inv.input },
            { stepKey: 'transfer' },
          );
          return { kind: 'completed', output: r };
        },
      },
    );
    const inst = await app.createInstance(
      {
        definition: { id: 'mover', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'i',
      },
      alice,
    );
    const ok = await app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'ok',
        correlationId: 'ok',
      },
      alice,
    );
    const bad = await app.delegate(
      {
        target: { instanceId: inst.id },
        input: { fail: true },
        idempotencyKey: 'bad',
        correlationId: 'bad',
      },
      alice,
    );
    // The failing provider is retryable: run until its retries are exhausted.
    for (let i = 0; i < 12; i++) {
      await app.runUntilIdle();
      clock.advanceBy(15 * 60 * 1000);
    }
    expect((await app.getTask(ok.taskId, alice)).status).toBe('completed');
    const failed = await app.getTask(bad.taskId, alice);
    expect(failed.status).toBe('failed');

    const spanData = spans.getFinishedSpans().map((sp) => ({
      name: sp.name,
      attributes: sp.attributes,
      events: sp.events,
      status: sp.status,
    }));
    expect(spanData.length).toBeGreaterThan(0);
    const everything: unknown[] = [failed, audit.events, spanData];
    await store.transaction(async (tx) => {
      for (const c of [
        'tasks',
        'executions',
        'checkpoints',
        'effects',
        'outbox',
        'inbox',
        'audit',
        'idempotency',
      ] as const)
        everything.push(await tx.find(c, {}));
    });
    const haystack = JSON.stringify(everything);
    expect(haystack.length).toBeGreaterThan(1000);
    expect(haystack).not.toContain(SECRET);
  });
});

describe('payload size limits (FEAT-040.2)', () => {
  const big = (n: number) => 'x'.repeat(n);
  function small() {
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
      limits: {
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        maxEventBytes: 256,
        maxPromptBytes: 64,
      },
    });
    return app;
  }
  async function start(app: ReturnType<typeof small>, agent: Agent, id = 'a') {
    app.define(
      def(id, {
        capabilities: [{ id: 'human-input', versionRange: '^1.0.0' }],
      }),
      agent,
    );
    const inst = await app.createInstance(
      {
        definition: { id, version: '1.0.0' },
        ownerId: alice.id,
        idempotencyKey: `i-${id}`,
      },
      alice,
    );
    return (input: unknown, key: string) =>
      app.delegate(
        {
          target: { instanceId: inst.id },
          input,
          idempotencyKey: key,
          correlationId: key,
        },
        alice,
      );
  }

  it('a task input over the limit is refused at acceptance, one under it is accepted', async () => {
    const app = small();
    const delegate = await start(app, {
      handle: async () => ({ kind: 'completed', output: null }),
    });
    expect(await code(delegate({ blob: big(2_000) }, 'big'))).toBe(
      'SchemaViolation',
    );
    expect(await code(delegate({ blob: big(100) }, 'ok'))).toBe('no-error');
  });

  it('an output over the limit fails the task with SchemaViolation', async () => {
    const app = small();
    const delegate = await start(app, {
      handle: async () => ({ kind: 'completed', output: big(2_000) }),
    });
    const t = await delegate({}, 'k');
    await app.runUntilIdle();
    const snap = await app.getTask(t.taskId, alice);
    expect([snap.status, snap.outcome?.code]).toEqual([
      'failed',
      'SchemaViolation',
    ]);
  });

  it('an inbound event payload over the limit is refused; a human-action prompt over the limit is refused', async () => {
    const app = small();
    expect(
      await code(
        app.publishEvent({
          eventId: 'e-big',
          source: 'feed',
          tenantId: 't-1',
          payload: { blob: big(1_000) },
        }),
      ),
    ).toBe('SchemaViolation');
    expect(
      await app.publishEvent({
        eventId: 'e-ok',
        source: 'feed',
        tenantId: 't-1',
        payload: { n: 1 },
      }),
    ).toBe(true);

    const delegate = await start(
      app,
      {
        handle: async (_inv, ctx) => {
          await ctx.capabilities.invoke(
            'human-input',
            'requestAction',
            {
              kind: 'text',
              prompt: big(200),
              inputSchema: { type: 'string' },
              assignees: { principalIds: ['alice'] },
              onExpiry: 'fail-task',
            },
            { stepKey: 'ask' },
          );
          return { kind: 'completed', output: null };
        },
      },
      'asker',
    );
    const t = await delegate({}, 'p');
    await app.runUntilIdle();
    const snap = await app.getTask(t.taskId, alice);
    expect([snap.status, snap.outcome?.code]).toEqual([
      'failed',
      'SchemaViolation',
    ]);
  });
});

describe('tool lifecycle status lives in the store (FEAT-074)', () => {
  const alice: TrustedPrincipal = {
    id: 'alice',
    type: 'user',
    tenantId: 't-1',
  };
  const tool = {
    id: 'bank.transfer',
    version: '1.0.0',
    description: 'transfer',
    inputSchema: true as const,
    effect: 'external' as const,
    idempotency: 'at-least-once' as const,
    permission: 'tool:bank.transfer:call',
  };
  const bindings = [
    {
      bindingId: 'direct',
      toolId: tool.id,
      toolVersion: tool.version,
      providerId: 'direct',
      providerVersion: '1.0.0',
      config: { function: 'transfer' },
      default: true,
    },
  ];
  const ref = { id: tool.id, version: tool.version };

  /** One process: its own registry and executor over the shared store. */
  function process_(store: ReturnType<typeof sqliteTempStore>, trusted = true) {
    const pdp = new FakePolicy();
    const audit = new FakeAudit();
    const security = { pdp, audit, now: () => '2026-11-14T00:00:00.000Z' };
    const registry = new InMemoryToolRegistry(security, () => trusted, {
      store,
    });
    const providers = new ToolProviderRegistry();
    const executor = new DefaultToolExecutor({
      ...security,
      registry,
      providers,
    });
    const register = () =>
      registry.register(
        tool,
        bindings,
        { publisher: 'acme', source: 'test' },
        alice,
      );
    const call = async () => {
      const rec = registry.get(ref)!;
      return code(
        executor.invoke(
          {
            toolId: tool.id,
            toolVersion: tool.version,
            bindingId: 'direct',
            providerId: 'direct',
            providerVersion: '1.0.0',
            digest: rec.provenance.digest,
          },
          {},
          {} as never,
        ),
      );
    };
    return { registry, register, call };
  }

  it('FEAT-074: a tool revoked through one app is refused by a second app on the same store, also after both restart', async () => {
    const store = sqliteTempStore();
    const a = process_(store);
    const b = process_(store);
    await a.register();
    await a.registry.activate(ref, alice);
    // The second process starts later and finds the tool as the first left it.
    expect((await b.register()).status).toBe('active');
    await a.registry.revoke(ref, alice);
    // Its own record is stale, but the status it acts on comes from the store.
    expect(await b.call()).toBe('PermissionDenied');
    expect((await b.registry.refreshed(ref))?.status).toBe('revoked');
    expect(await b.registry.discover({}, alice)).toEqual([]);

    // Both restart: a bootstrap registers and activates again, and gets nowhere.
    const a2 = process_(store);
    const b2 = process_(store);
    expect((await a2.register()).status).toBe('revoked');
    expect(await code(a2.registry.activate(ref, alice))).toBe('InvalidState');
    expect(await code(b2.registry.activate(ref, alice))).toBe('NotFound');
    expect(await a2.call()).toBe('PermissionDenied');
    expect((await b2.register()).status).toBe('revoked');
    expect(await b2.call()).toBe('PermissionDenied');
  });

  it('FEAT-074: a suspension reaches another worker and survives a restart; resuming is explicit', async () => {
    const store = sqliteTempStore();
    const a = process_(store);
    const b = process_(store);
    await a.register();
    await a.registry.activate(ref, alice);
    await b.register();
    await a.registry.suspend(ref, alice);
    expect(await b.call()).toBe('PermissionDenied');
    const restarted = process_(store);
    expect((await restarted.register()).status).toBe('suspended');
    await restarted.registry.activate(ref, alice); // an operator resumes it
    const other = process_(store);
    expect((await other.register()).status).toBe('active');
  });

  it('FEAT-074: an unverified tool still cannot be activated, whatever the store says', async () => {
    const store = sqliteTempStore();
    const untrusted = process_(store, false);
    await untrusted.register();
    expect(await code(untrusted.registry.activate(ref, alice))).toBe(
      'PermissionDenied',
    );
    // A row written for it by someone with store access does not make it usable.
    await store.transaction((tx) =>
      tx.insert('lifecycle', `tool:${ref.id}@${ref.version}`, {
        kind: 'tool',
        id: ref.id,
        version: ref.version,
        status: 'active',
      }),
    );
    const again = process_(store, false);
    expect((await again.register()).status).toBe('registered');
    expect(await again.call()).toBe('PermissionDenied');
  });
});
