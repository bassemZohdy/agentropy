// FEAT-027.8: A2A provider (C-03) pinned to A2A 1.0 JSON-RPC, and a custom broker/RPC provider sample (C-04).
// Both run the shared Communication conformance suite offline; the A2A transport is a fake fetch into an in-process
// A2A server. Threat-model rows TM-27/TM-28 are verified here.
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type AgentRef,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  BrokerCommunicationProvider,
  InMemoryBroker,
  serveOnBroker,
} from '../../examples/src/broker-provider.js';
import {
  A2ACommunicationProvider,
  A2A_PROTOCOL_VERSION,
  DefaultCommunicationRouter,
  a2aAgentCard,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type A2AServer,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import {
  FakeClock,
  FakeDirectTarget,
  FakePolicy,
  defineCommunicationConformance,
} from '../src/index.js';

const caller: TrustedPrincipal = {
  id: 'svc-a',
  type: 'service',
  tenantId: 't-1',
};

/** Fake HTTP: bearer token → principal (the transport's authentication), then the A2A server. */
function transport(
  server: A2AServer,
  tokens: Record<string, TrustedPrincipal>,
) {
  const seen: { headers: Record<string, string>; body: string }[] = [];
  const fetch = async (
    _url: string,
    init: { headers: Record<string, string>; body: string },
  ) => {
    seen.push({ headers: init.headers, body: init.body });
    const token = init.headers.authorization?.replace(/^Bearer /, '');
    const principal = token ? tokens[token] : undefined;
    const res = await server.handle(JSON.parse(init.body), principal, {
      'a2a-version': init.headers['a2a-version'],
    });
    return { status: res.status, json: async () => res.body };
  };
  return { fetch, seen };
}

const credentials = (token: string) => ({
  resolve: async () => ({ token }),
});

defineCommunicationConformance({ describe, it, expect }, 'a2a', () => {
  const fake = new FakeDirectTarget();
  const { fetch } = transport(createA2AServer(fake), { 'tok-a': caller });
  const provider = new A2ACommunicationProvider({
    fetch,
    credentialRef: 'peer-b',
    credentials: credentials('tok-a'),
    maxPolls: 0,
    now: () => '2026-11-05T00:00:00.000Z',
  });
  const router = new DefaultCommunicationRouter();
  router.register(provider);
  const target: AgentRef = {
    definitionId: 'worker',
    version: '1.0.0',
    tenantId: 't-1',
    endpoint: 'https://peer-b.example/a2a',
  };
  return { router, provider, target, caller, received: () => fake.received };
});

defineCommunicationConformance(
  { describe, it, expect },
  'custom broker sample',
  () => {
    const fake = new FakeDirectTarget();
    const broker = new InMemoryBroker();
    serveOnBroker(broker, 'agents.t-1.worker', fake);
    const provider = new BrokerCommunicationProvider(
      broker,
      (t) => `agents.${t.tenantId}.${t.definitionId}`,
      () => '2026-11-05T00:00:00.000Z',
    );
    const router = new DefaultCommunicationRouter();
    router.register(provider);
    return {
      router,
      provider,
      target: {
        definitionId: 'worker',
        version: '1.0.0',
        tenantId: 't-1',
        endpoint: 'broker:agents',
      },
      caller,
      received: () => fake.received,
    };
  },
);

const def = (id: string): AgentDefinition => ({
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
});

describe('A2A end to end between two Agentropy runtimes', () => {
  async function peers() {
    // Runtime B exposes bob's "summarizer" over A2A; runtime A calls it as service "svc-a".
    const pdpB = new FakePolicy();
    const b = createLocalApp({
      store: sqliteTempStore(),
      pdp: pdpB,
      now: new FakeClock('2026-11-05T00:00:00.000Z').iso,
      profiles: BUILTIN_PROFILES,
    });
    b.define(def('summarizer'), {
      handle: async (inv) => ({
        kind: 'completed',
        output: { summary: `summary of ${(inv.input as { doc: string }).doc}` },
      }),
    });
    const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
    const inst = await b.createInstance(
      {
        definition: { id: 'summarizer', version: '1.0.0' },
        ownerId: 'bob',
        idempotencyKey: 's',
      },
      bob,
    );
    const server = createA2AServer(localAppTarget(b), { instanceId: inst.id });
    const { fetch, seen } = transport(server, { 'tok-a': caller });
    const a2a = new A2ACommunicationProvider({
      fetch,
      credentialRef: 'peer-b',
      credentials: credentials('tok-a'),
      maxPolls: 0,
    });
    const router = new DefaultCommunicationRouter();
    router.register(a2a);
    const target: AgentRef = {
      definitionId: 'summarizer',
      tenantId: 't-1',
      endpoint: 'https://b.example/a2a',
    };
    const ctx = {
      caller: { ...caller, delegatedAuthorityRef: 'g-local-secret' },
      correlationId: 'c-1',
    };
    const route = await router.selectRoute(target, 'delegate', ctx);
    return { b, server, seen, a2a, route, ctx, pdpB };
  }

  it('SendMessage creates a remote task that B runs; GetTask maps its state; the remote result is authoritative', async () => {
    const p = await peers();
    const ref = await p.a2a.delegate(
      p.route,
      {
        target: {},
        input: { doc: 'q3-report' },
        idempotencyKey: 'msg-1',
        correlationId: 'c-1',
      },
      p.ctx,
    );
    expect(ref.localTaskId).toBe(`a2a:${ref.remoteTaskId}`);
    expect((await p.a2a.getTask(ref, p.ctx)).remoteState).toBe(
      'TASK_STATE_SUBMITTED',
    );
    await p.b.runUntilIdle();
    const state = await p.a2a.getTask(ref, p.ctx);
    expect(state).toMatchObject({
      remoteState: 'TASK_STATE_COMPLETED',
      normalized: 'completed',
    });
    const raw = await p.server.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'GetTask',
        params: { id: ref.remoteTaskId },
      },
      caller,
      { 'a2a-version': A2A_PROTOCOL_VERSION },
    );
    expect((raw.body.result as { artifacts: unknown }).artifacts).toEqual([
      {
        artifactId: `${ref.remoteTaskId}:output`,
        parts: [
          {
            text: JSON.stringify({ summary: 'summary of q3-report' }),
            mediaType: 'application/json',
          },
        ],
      },
    ]);
    // Redelivery of the same message ID maps to the same remote task.
    const again = await p.a2a.delegate(
      p.route,
      {
        target: {},
        input: { doc: 'q3-report' },
        idempotencyKey: 'msg-1',
        correlationId: 'c-1',
      },
      p.ctx,
    );
    expect(again.remoteTaskId).toBe(ref.remoteTaskId);
  });

  it('TM-27: the peer is identified by transport authentication; B’s own policy decides; unauthenticated calls get 401', async () => {
    const p = await peers();
    p.pdpB.denied.add('delegation:delegate');
    expect(
      await code(
        p.a2a.delegate(
          p.route,
          {
            target: {},
            input: { doc: 'x' },
            idempotencyKey: 'm2',
            correlationId: 'c',
          },
          p.ctx,
        ),
      ),
    ).toBe('PermissionDenied');
    const anonymous = await p.server.handle(
      { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } },
      undefined,
    );
    expect(anonymous.status).toBe(401);
    const noCred = new A2ACommunicationProvider({
      fetch: transport(p.server, {}).fetch,
    });
    expect(
      await code(
        noCred.delegate(
          p.route,
          { target: {}, input: {}, idempotencyKey: 'm3', correlationId: 'c' },
          p.ctx,
        ),
      ),
    ).toBe('AuthorityExpired');
  });

  it('TM-28: no local grant or caller identity crosses the boundary; remote errors map to typed codes', async () => {
    const p = await peers();
    await p.a2a.delegate(
      p.route,
      {
        target: {},
        input: { doc: 'x' },
        idempotencyKey: 'm4',
        correlationId: 'c',
      },
      p.ctx,
    );
    const wire = JSON.stringify(p.seen);
    expect(wire).not.toContain('g-local-secret');
    expect(p.seen[0]!.headers['a2a-version']).toBe('1.0');
    expect(JSON.parse(p.seen[0]!.body)).toMatchObject({
      jsonrpc: '2.0',
      method: 'SendMessage',
      params: {
        message: { role: 'ROLE_USER', messageId: 'm4', contextId: 'c' },
      },
    });
    expect(
      await code(
        p.a2a.getTask(
          { route: p.route, localTaskId: 'a2a:nope', remoteTaskId: 'nope' },
          p.ctx,
        ),
      ),
    ).toBe('NotFound');
  });

  it('protocol rules: version negotiation, unknown methods, task continuation and content types', async () => {
    const p = await peers();
    const call = (body: unknown, version?: string) =>
      p.server.handle(body, caller, version ? { 'a2a-version': version } : {});
    expect(
      (
        await call(
          { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } },
          '0.3',
        )
      ).body.error?.code,
    ).toBe(-32009);
    expect(
      (await call({ jsonrpc: '2.0', id: 1, method: 'ListTask', params: {} }))
        .body.error?.code,
    ).toBe(-32601);
    expect(
      (
        await call({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              messageId: 'm',
              taskId: 'missing',
              parts: [{ text: 'more' }],
            },
          },
        })
      ).body.error?.code,
    ).toBe(-32001); // continuing a task that does not exist: TaskNotFoundError
    expect(
      (
        await call({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              messageId: 'm',
              parts: [{ text: 'x', mediaType: 'image/png' }],
            },
          },
        })
      ).body.error?.code,
    ).toBe(-32005);
    expect((await call({ id: 1, method: 'GetTask' })).body.error?.code).toBe(
      -32600,
    );
  });

  it('publishes an AgentCard describing the JSON-RPC interface and protocol version', () => {
    expect(
      a2aAgentCard({
        name: 'Summarizer',
        description: 'Summarizes documents',
        version: '1.0.0',
        url: 'https://b.example/a2a',
        securitySchemes: {
          bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
        },
        security: [{ bearer: [] }],
      }),
    ).toMatchObject({
      supportedInterfaces: [
        {
          url: 'https://b.example/a2a',
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        },
      ],
      capabilities: { streaming: false, pushNotifications: false },
    });
  });
});

describe('A2A 1.0: ListTasks, task continuation and file parts (FEAT-034.4)', () => {
  async function endpoint() {
    const b = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
      profiles: BUILTIN_PROFILES,
    });
    // Asks its caller a question (INPUT_REQUIRED), then answers with what it was told.
    b.define(
      {
        ...def('asker'),
        capabilities: [{ id: 'human-input', versionRange: '^1.0.0' }],
      },
      {
        handle: async (inv, ctx) => {
          if (inv.activation > 1)
            return { kind: 'completed', output: { told: inv.wakeReason } };
          const { requestId } = await ctx.capabilities.invoke<
            unknown,
            { requestId: string }
          >(
            'human-input',
            'requestAction',
            {
              kind: 'text',
              prompt: 'Which colour?',
              inputSchema: { type: 'string' },
              assignees: { principalIds: [caller.id] },
              onExpiry: 'fail-task',
            },
            { stepKey: 'ask' },
          );
          return {
            kind: 'waiting',
            wakeup: { anyOf: [{ kind: 'human-action', requestId }] },
            checkpoint: { requestId },
          };
        },
      },
    );
    b.define(def('echo'), {
      handle: async (inv) => ({ kind: 'completed', output: inv.input }),
    });
    const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
    const server = async (id: string) => {
      const inst = await b.createInstance(
        {
          definition: { id, version: '1.0.0' },
          ownerId: 'bob',
          idempotencyKey: id,
        },
        bob,
      );
      return createA2AServer(localAppTarget(b), { instanceId: inst.id });
    };
    return { b, asker: await server('asker'), echo: await server('echo') };
  }

  const rpc = async (
    server: A2AServer,
    method: string,
    params: Record<string, unknown>,
    who: TrustedPrincipal = caller,
  ) =>
    (await server.handle({ jsonrpc: '2.0', id: 1, method, params }, who)).body;

  const message = (
    messageId: string,
    parts: unknown[],
    extra: Record<string, unknown> = {},
  ) => ({ message: { role: 'ROLE_USER', messageId, parts, ...extra } });

  type Task = {
    id: string;
    contextId?: string;
    status: { state: string; timestamp: string };
    artifacts?: { parts: { text?: string }[] }[];
  };
  const eve: TrustedPrincipal = { id: 'eve', type: 'user', tenantId: 't-1' };

  it('a message with taskId answers a task waiting for input; contextId must match; terminal tasks refuse', async () => {
    const e = await endpoint();
    const sent = (
      await rpc(
        e.asker,
        'SendMessage',
        message('m-1', [{ text: 'start' }], { contextId: 'ctx-1' }),
      )
    ).result as { task: Task };
    const taskId = sent.task.id;
    // Not waiting for input yet (it has not run): refused.
    expect(
      (
        await rpc(
          e.asker,
          'SendMessage',
          message('m-early', [{ text: 'x' }], { taskId }),
        )
      ).error?.code,
    ).toBe(-32004);
    await e.b.runUntilIdle();
    const waiting = (await rpc(e.asker, 'GetTask', { id: taskId }))
      .result as Task;
    expect(waiting).toMatchObject({
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        timestamp: '2026-11-06T00:00:00.000Z',
      },
    });
    expect(
      (
        await rpc(
          e.asker,
          'SendMessage',
          message('m-2', [{ text: 'blue' }], { taskId, contextId: 'other' }),
        )
      ).error?.code,
    ).toBe(-32602);
    // Another principal cannot continue it: the task is not visible to them.
    expect(
      (
        await rpc(
          e.asker,
          'SendMessage',
          message('m-3', [{ text: 'x' }], { taskId }),
          eve,
        )
      ).error?.code,
    ).toBe(-32001);
    const answered = (
      await rpc(
        e.asker,
        'SendMessage',
        message('m-4', [{ text: 'blue' }], { taskId, contextId: 'ctx-1' }),
      )
    ).result as { task: Task };
    expect(answered.task.id).toBe(taskId);
    await e.b.runUntilIdle();
    const done = (await rpc(e.asker, 'GetTask', { id: taskId })).result as Task;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(done.artifacts![0]!.parts[0]!.text).toContain('blue');
    expect(
      (
        await rpc(
          e.asker,
          'SendMessage',
          message('m-5', [{ text: 'again' }], { taskId }),
        )
      ).error?.code,
    ).toBe(-32004);
  });

  it('ListTasks pages the caller’s tasks newest first, filters by context and state, and hides others’ tasks', async () => {
    const e = await endpoint();
    for (const [i, ctx] of ['a', 'b', 'a'].entries())
      await rpc(
        e.echo,
        'SendMessage',
        message(`m-${i}`, [{ text: `t${i}` }], { contextId: ctx }),
      );
    const first = (await rpc(e.echo, 'ListTasks', { pageSize: 2 })).result as {
      tasks: Task[];
      nextPageToken: string;
      pageSize: number;
      totalSize: number;
    };
    expect([first.tasks.length, first.pageSize, first.totalSize]).toEqual([
      2, 2, 3,
    ]);
    expect(first.nextPageToken).not.toBe('');
    const second = (
      await rpc(e.echo, 'ListTasks', {
        pageSize: 2,
        pageToken: first.nextPageToken,
      })
    ).result as { tasks: Task[]; nextPageToken: string };
    expect(second.tasks).toHaveLength(1);
    expect(second.nextPageToken).toBe('');
    const ids = [...first.tasks, ...second.tasks].map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([...ids].sort().reverse()); // equal timestamps: task ID breaks the tie
    const inA = (await rpc(e.echo, 'ListTasks', { contextId: 'a' })).result as {
      tasks: Task[];
    };
    expect(inA.tasks.map((t) => t.contextId)).toEqual(['a', 'a']);

    await e.b.runUntilIdle();
    const completed = (
      await rpc(e.echo, 'ListTasks', { status: 'TASK_STATE_COMPLETED' })
    ).result as { tasks: Task[] };
    expect(completed.tasks).toHaveLength(3);
    expect(completed.tasks[0]!.artifacts).toBeUndefined();
    const withArtifacts = (
      await rpc(e.echo, 'ListTasks', { includeArtifacts: true, pageSize: 1 })
    ).result as { tasks: Task[] };
    expect(withArtifacts.tasks[0]!.artifacts).toHaveLength(1);
    const later = (
      await rpc(e.echo, 'ListTasks', {
        statusTimestampAfter: '2026-11-07T00:00:00Z',
      })
    ).result as { tasks: Task[] };
    expect(later.tasks).toEqual([]);

    expect(
      ((await rpc(e.echo, 'ListTasks', {}, eve)).result as { tasks: Task[] })
        .tasks,
    ).toEqual([]);
    for (const bad of [
      { pageSize: 101 },
      { pageSize: 0 },
      { status: 'DONE' },
      { pageToken: '!!' },
    ])
      expect((await rpc(e.echo, 'ListTasks', bad)).error?.code).toBe(-32602);
  });

  it('file and data parts reach the agent as data; malformed parts are refused', async () => {
    const e = await endpoint();
    const raw = Buffer.from('hello file').toString('base64');
    const send = (id: string, parts: unknown[]) =>
      rpc(e.echo, 'SendMessage', message(id, parts));
    const multi = (
      await send('m-1', [
        { text: 'see attached' },
        { raw, filename: 'a.txt', mediaType: 'text/plain' },
        { url: 'https://files.example/b.pdf', mediaType: 'application/pdf' },
      ])
    ).result as { task: Task };
    const data = (await send('m-2', [{ data: { amount: 42 } }])).result as {
      task: Task;
    };
    await e.b.runUntilIdle();
    expect(await e.b.getResult(multi.task.id, caller)).toEqual({
      parts: [
        { kind: 'text', text: 'see attached' },
        { kind: 'file', raw, filename: 'a.txt', mediaType: 'text/plain' },
        {
          kind: 'file',
          url: 'https://files.example/b.pdf',
          mediaType: 'application/pdf',
        },
      ],
    });
    expect(await e.b.getResult(data.task.id, caller)).toEqual({ amount: 42 });
    const bad: unknown[][] = [
      [{ raw: 'not base64!' }],
      [{ url: 'file:///etc/passwd' }],
      [{ text: 'a', data: 1 }],
      [],
      Array.from({ length: 17 }, () => ({ text: 'x' })),
    ];
    for (const [i, parts] of bad.entries())
      expect((await send(`bad-${i}`, parts)).error?.code).toBe(-32602);
  });
});
