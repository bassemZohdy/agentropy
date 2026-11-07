// FEAT-027.5: workflow-backed deterministic agent (M2-07) and an AI agent on a real-wire-format reasoning provider
// with bounded tools and budget (M2-08). Offline: the OpenAI-compatible adapter talks to a fake fetch that replays
// recorded Chat Completions fixtures.
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type CredentialProvider,
  type ToolDescriptor,
  type TrustedPrincipal,
} from '@agentropy/core';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DefaultToolExecutor,
  DirectToolProvider,
  InMemoryToolRegistry,
  ToolProviderRegistry,
  WORKFLOW_SOURCE,
  bridgeWorkflowCompletions,
  createLocalApp,
  openAICompatibleReasoning,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import {
  FakeAudit,
  FakeClock,
  FakePolicy,
  FakeWorkflowEngine,
} from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/openai/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as unknown;

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

describe('workflow-backed deterministic agent (M2-07)', () => {
  function setup() {
    const engine = new FakeWorkflowEngine({
      'invoice-approval': (input) => ({
        approved: (input as { amount: number }).amount < 1_000,
      }),
      broken: () => {
        throw new Error('engine step failed');
      },
    });
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      now: new FakeClock('2026-11-05T00:00:00.000Z').iso,
      profiles: BUILTIN_PROFILES,
      workflow: engine,
    });
    /** No model: subscribe to its run's completion, start the workflow, wait, then report the engine result. */
    const agent: Agent<{ workflow: string; amount: number }> = {
      handle: async (inv, ctx) => {
        const cp = inv.checkpoint as { runId: string; sub: string } | undefined;
        if (inv.wakeReason?.kind === 'event' && cp) {
          const run = await ctx.capabilities.invoke<
            unknown,
            { state: string; output?: unknown; code?: string }
          >('workflow', 'status', { runId: cp.runId });
          return run.state === 'completed'
            ? { kind: 'completed', output: run.output }
            : {
                kind: 'failed',
                code: 'TaskFailed',
                message: 'Workflow failed',
                retryable: false,
              };
        }
        const run = await ctx.capabilities.invoke<unknown, { runId: string }>(
          'workflow',
          'start',
          { workflow: inv.input.workflow, input: { amount: inv.input.amount } },
          { stepKey: 'start' },
        );
        const { subscription } = await ctx.capabilities.invoke<
          unknown,
          { subscription: string }
        >(
          'event-handling',
          'subscribe',
          { source: WORKFLOW_SOURCE, filter: { runId: run.runId } },
          { stepKey: `wait:${run.runId}` },
        );
        return {
          kind: 'waiting',
          wakeup: { anyOf: [{ kind: 'event', subscription }] },
          checkpoint: { runId: run.runId, sub: subscription },
        };
      },
    };
    app.define(
      def('approver', {
        capabilities: [
          { id: 'workflow', versionRange: '^1.0.0' },
          { id: 'event-handling', versionRange: '^1.0.0' },
        ],
      }),
      agent,
    );
    const run = async (workflow: string, amount: number, key: string) => {
      const inst = await app.createInstance(
        {
          definition: { id: 'approver', version: '1.0.0' },
          ownerId: 'alice',
          idempotencyKey: key,
        },
        alice,
      );
      return app.delegate(
        {
          target: { instanceId: inst.id },
          input: { workflow, amount },
          idempotencyKey: key,
          correlationId: key,
        },
        alice,
      );
    };
    return { app, engine, run };
  }

  it('starts the run once, waits without polling, and completes with the engine’s result when it finishes', async () => {
    const { app, engine, run } = setup();
    const t = await run('invoice-approval', 400, 'a');
    await app.runUntilIdle();
    expect((await app.getTask(t.taskId, alice)).status).toBe('waiting');
    expect(engine.starts).toBe(1);
    await engine.finish('run-1');
    await app.runUntilIdle();
    expect(await app.getResult(t.taskId, alice)).toEqual({ approved: true });
    expect(engine.starts).toBe(1);
  });

  it('a failed run fails the agent task; start is idempotent per step key', async () => {
    const { app, engine, run } = setup();
    const t = await run('broken', 1, 'b');
    await app.runUntilIdle();
    await engine.finish('run-1');
    await app.runUntilIdle();
    expect((await app.getTask(t.taskId, alice)).outcome?.code).toBe(
      'TaskFailed',
    );
    // Replaying the same step key against the engine returns the same run.
    const again = await engine.start(
      'broken',
      {},
      {
        tenantId: 't-1',
        taskId: t.taskId,
        idempotencyKey: [
          ...(engine as unknown as { byKey: Map<string, string> }).byKey.keys(),
        ][0]!,
      },
    );
    expect(again.runId).toBe('run-1');
    expect(engine.starts).toBe(1);
  });
});

describe('AI agent on an OpenAI-compatible provider (M2-08)', () => {
  const quote: ToolDescriptor = {
    id: 'finance.quote',
    version: '1.0.0',
    description: 'Current price for a symbol',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
    effect: 'read',
    idempotency: 'idempotent',
    permission: 'tool:finance.quote:call',
  };

  async function setup(opts: {
    budget?: number;
    responses: unknown[];
    key?: string;
  }) {
    const requests: {
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }[] = [];
    const queue = [...opts.responses];
    const fakeFetch = async (
      url: string,
      init: { headers: Record<string, string>; body: string },
    ) => {
      requests.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      const next = queue.shift() as
        { status?: number; body?: unknown } | undefined;
      return {
        status: next?.status ?? 200,
        json: async () => next?.body ?? next,
      };
    };
    const credentials: CredentialProvider = {
      resolve: async () => (opts.key ? { apiKey: opts.key } : {}),
    };
    const pdp = new FakePolicy();
    const audit = new FakeAudit();
    const clock = new FakeClock('2026-11-05T00:00:00.000Z');
    const registry = new InMemoryToolRegistry(
      { pdp, audit, now: clock.iso },
      () => true,
    );
    const providers = new ToolProviderRegistry();
    providers.register(
      new DirectToolProvider({ quote: () => ({ price: 99 }) }),
    );
    await registry.register(
      quote,
      [
        {
          bindingId: 'direct',
          toolId: quote.id,
          toolVersion: quote.version,
          providerId: 'direct',
          providerVersion: '1.0.0',
          config: { function: 'quote' },
          default: true,
        },
      ],
      { publisher: 'acme', source: 'test' },
      alice,
    );
    await registry.activate({ id: quote.id, version: quote.version }, alice);
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp,
      audit,
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
        }),
      },
      reasoning: openAICompatibleReasoning({
        baseUrl: 'https://llm.example.internal/v1/',
        model: 'gpt-fixture',
        credentialRef: 'llm-key',
        credentials,
        fetch: fakeFetch,
      }),
    });
    return { app, requests };
  }

  const analyst: Agent<{ question: string; offerTools?: boolean }> = {
    handle: async (inv, ctx) => {
      const r = await ctx.capabilities.invoke<
        unknown,
        {
          text: string;
          toolCalls?: { toolId: string; input: unknown }[];
          usage: unknown;
        }
      >('reasoning', 'complete', {
        system: 'You are a finance analyst.',
        prompt: inv.input.question,
        maxTokens: 500,
        ...(inv.input.offerTools ? { tools: ['finance.quote'] } : {}),
      });
      const results = [];
      for (const [i, call] of (r.toolCalls ?? []).entries())
        results.push(
          (
            await ctx.capabilities.invoke<unknown, { output: unknown }>(
              'tool-use',
              'call',
              { toolId: call.toolId, input: call.input },
              { stepKey: `tool-${i}` },
            )
          ).output,
        );
      return {
        kind: 'completed',
        output: { text: r.text, toolResults: results, usage: r.usage },
      };
    },
  };

  const start = async (
    app: Awaited<ReturnType<typeof setup>>['app'],
    input: { question: string; offerTools?: boolean },
    key: string,
    budget?: number,
  ) => {
    if (!app.definitions.get({ id: 'analyst', version: '1.0.0' }))
      app.define(
        def('analyst', {
          capabilities: [
            { id: 'reasoning', versionRange: '^1.0.0' },
            { id: 'tool-use', versionRange: '^1.0.0' },
          ],
          tools: [{ id: 'finance.quote', versionRange: '^1.0.0' }],
        }),
        analyst,
      );
    const inst = await app.createInstance(
      {
        definition: { id: 'analyst', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: `i-${key}`,
      },
      alice,
    );
    const t = await app.delegate(
      {
        target: { instanceId: inst.id },
        input,
        idempotencyKey: key,
        correlationId: key,
        ...(budget !== undefined ? { budget: { maxCostUnits: budget } } : {}),
      },
      alice,
    );
    await app.runUntilIdle();
    return t;
  };

  it('sends a Chat Completions request with the resolved key and returns text and usage', async () => {
    const s = await setup({
      responses: [fixture('risk-summary')],
      key: 'sk-test-123',
    });
    const t = await start(s.app, { question: 'Assess expense 4200' }, 'k');
    expect(await s.app.getResult(t.taskId, alice)).toEqual({
      text: 'Risk: medium. Amount above the auto-approval limit.',
      toolResults: [],
      usage: { inputTokens: 42, outputTokens: 12 },
    });
    const [req] = s.requests;
    expect(req!.url).toBe('https://llm.example.internal/v1/chat/completions');
    expect(req!.headers.authorization).toBe('Bearer sk-test-123');
    expect(req!.body).toMatchObject({
      model: 'gpt-fixture',
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'You are a finance analyst.' },
        { role: 'user', content: 'Assess expense 4200' },
      ],
    });
    // The key never reaches the store.
    expect(
      JSON.stringify(
        await s.app.store.transaction((tx) => tx.find('usage', {})),
      ),
    ).not.toContain('sk-test');
  });

  it('offers only pinned tools; proposed calls run through tool-use with its pins and policy', async () => {
    const s = await setup({ responses: [fixture('tool-call')], key: 'k' });
    const t = await start(
      s.app,
      { question: 'Price of ACME?', offerTools: true },
      'k',
    );
    expect(s.requests[0]!.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'finance_quote',
          description: 'Current price for a symbol',
          parameters: quote.inputSchema,
        },
      },
    ]);
    expect(await s.app.getResult(t.taskId, alice)).toMatchObject({
      toolResults: [{ price: 99 }],
    });
  });

  it('enforces the task budget: caps maxTokens to what remains and refuses calls once it is spent', async () => {
    const s = await setup({
      responses: [fixture('risk-summary'), fixture('risk-summary')],
      key: 'k',
    });
    const first = await start(s.app, { question: 'q' }, 'a', 100);
    expect(s.requests[0]!.body.max_tokens).toBe(100);
    expect((await s.app.getTask(first.taskId, alice)).status).toBe('completed');
    // Budget 54 = exactly one fixture call: the second call in the same task is refused before any request.
    s.app.define(
      def('twice', {
        capabilities: [{ id: 'reasoning', versionRange: '^1.0.0' }],
      }),
      {
        handle: async (_inv, ctx) => {
          await ctx.capabilities.invoke('reasoning', 'complete', {
            prompt: 'one',
          });
          await ctx.capabilities.invoke('reasoning', 'complete', {
            prompt: 'two',
          });
          return { kind: 'completed', output: null };
        },
      },
    );
    const inst = await s.app.createInstance(
      {
        definition: { id: 'twice', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'tw',
      },
      alice,
    );
    const tight = await s.app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'tw',
        correlationId: 'tw',
        budget: { maxCostUnits: 54 },
      },
      alice,
    );
    await s.app.runUntilIdle();
    expect((await s.app.getTask(tight.taskId, alice)).outcome?.code).toBe(
      'BudgetExceeded',
    );
    expect(s.requests).toHaveLength(2);
  });

  it('maps provider failures to typed errors without passing provider bodies through', async () => {
    for (const [status, expected] of [
      [401, 'AuthorityExpired'],
      [429, 'QuotaExceeded'],
      [503, 'ProviderUnavailable'],
      [400, 'SchemaViolation'],
    ] as const) {
      const s = await setup({
        responses: [
          {
            status,
            body: { error: { message: `secret prompt echo ${status}` } },
          },
        ],
        key: 'k',
      });
      const provider = openAICompatibleReasoning({
        baseUrl: 'https://x/v1',
        model: 'm',
        fetch: async () => ({
          status,
          json: async () => ({ error: { message: 'echo sk-1' } }),
        }),
      });
      let err: unknown;
      try {
        await provider.complete(
          { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 },
          {
            tenantId: 't-1',
            taskId: 't',
            signal: new AbortController().signal,
          },
        );
      } catch (e) {
        err = e;
      }
      expect((err as { code: string }).code).toBe(expected);
      expect(JSON.stringify(err)).not.toContain('echo');
      void s;
    }
    const unreachable = openAICompatibleReasoning({
      baseUrl: 'https://x/v1',
      model: 'm',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(
      await code(
        unreachable.complete(
          { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 },
          {
            tenantId: 't-1',
            taskId: 't',
            signal: new AbortController().signal,
          },
        ),
      ),
    ).toBe('ProviderUnavailable');
  });

  it('rejects unpinned tools and missing prompts at the capability boundary', async () => {
    const s = await setup({ responses: [], key: 'k' });
    s.app.define(
      def('bad', {
        capabilities: [{ id: 'reasoning', versionRange: '^1.0.0' }],
      }),
      {
        handle: async (inv, ctx) => {
          await ctx.capabilities.invoke(
            'reasoning',
            'complete',
            (inv.input as { variant: string }).variant === 'tool'
              ? { prompt: 'x', tools: ['finance.quote'] }
              : {},
          );
          return { kind: 'completed', output: null };
        },
      },
    );
    const inst = await s.app.createInstance(
      {
        definition: { id: 'bad', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'bad',
      },
      alice,
    );
    const tool = await s.app.delegate(
      {
        target: { instanceId: inst.id },
        input: { variant: 'tool' },
        idempotencyKey: 't',
        correlationId: 't',
      },
      alice,
    );
    const empty = await s.app.delegate(
      {
        target: { instanceId: inst.id },
        input: { variant: 'empty' },
        idempotencyKey: 'e',
        correlationId: 'e',
      },
      alice,
    );
    await s.app.runUntilIdle();
    expect((await s.app.getTask(tool.taskId, alice)).outcome?.code).toBe(
      'CapabilityNotDeclared',
    );
    expect((await s.app.getTask(empty.taskId, alice)).outcome?.code).toBe(
      'SchemaViolation',
    );
    expect(s.requests).toHaveLength(0);
  });
});

describe('workflow completion delivery (FEAT-038.2)', () => {
  it('retries a failed publish, reports it when attempts run out, and polls engines that cannot push', async () => {
    const engine = new FakeWorkflowEngine({ w: () => 'done' });
    let failures = 2;
    const published: string[] = [];
    bridgeWorkflowCompletions(
      engine,
      async (e) => {
        if (failures-- > 0) throw new Error('store blip');
        published.push(e.eventId);
        return true;
      },
      { retryMs: 1 },
    );
    const ctx = { tenantId: 't-1', taskId: 'task', idempotencyKey: 'k1' };
    const run = await engine.start('w', {}, ctx);
    await engine.finish(run.runId);
    await vi.waitFor(() =>
      expect(published).toEqual([`workflow:${run.runId}:completed`]),
    );

    const lost: unknown[] = [];
    const e2 = new FakeWorkflowEngine({ w: () => 1 });
    bridgeWorkflowCompletions(
      e2,
      async () => {
        throw new Error('down for good');
      },
      { attempts: 2, retryMs: 1, onError: (e) => lost.push(e) },
    );
    const r2 = await e2.start('w', {}, { ...ctx, idempotencyKey: 'k2' });
    await e2.finish(r2.runId);
    await vi.waitFor(() => expect(lost).toHaveLength(1));
  });

  it('createLocalApp polls an engine with poll() as a scheduler sweep, at most every workflowPollMs', async () => {
    const engine = new FakeWorkflowEngine();
    let polls = 0;
    (engine as { poll?: () => Promise<void> }).poll = async () => {
      polls++;
    };
    const clock = new FakeClock('2026-11-07T00:00:00.000Z');
    const app = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
      now: clock.iso,
      workflow: engine,
      workflowPollMs: 5_000,
    });
    await app.wakeups.poll();
    await app.wakeups.poll();
    expect(polls).toBe(1);
    clock.advanceBy(5_001);
    await app.wakeups.poll();
    expect(polls).toBe(2);
  });
});
