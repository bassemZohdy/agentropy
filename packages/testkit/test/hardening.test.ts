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
import * as api from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

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
      tracer: new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(spans)],
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
