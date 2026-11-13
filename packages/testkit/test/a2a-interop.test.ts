// FEAT-034.2: interoperability with the reference A2A JavaScript SDK (`@a2a-js/sdk`, pinned in devDependencies),
// offline. In one direction the SDK's client reads Agentropy's AgentCard through its own resolver and calls
// SendMessage, GetTask, ListTasks and SendStreamingMessage against an Agentropy A2A server. In the other,
// Agentropy's A2A provider delegates to a server built from the SDK's DefaultRequestHandler. Both directions use
// the A2A 1.0 JSON-RPC wire format; the transport is an in-process fetch, so CI needs no network.
import {
  Role,
  TaskState,
  type AgentCard as SdkAgentCard,
  type Message as SdkMessage,
  type Task as SdkTask,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  UnauthenticatedUser,
  defaultServerCallContextBuilder,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  A2ACommunicationProvider,
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  agentCardForDefinition,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  sseFrames,
  type A2AServer,
} from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const caller: TrustedPrincipal = {
  id: 'svc-a',
  type: 'service',
  tenantId: 't-1',
};
const BASE = 'https://agents.b.example';

const def: AgentDefinition = {
  id: 'summarizer',
  version: '1.0.0',
  displayName: 'Summarizer',
  profile: { id: 'task', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id: 'summarizer', version: '1.0.0' },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
};

/** An Agentropy runtime exposing `summarizer` over A2A, reachable through an in-process fetch. */
async function agentropyPeer() {
  const app = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
    profiles: BUILTIN_PROFILES,
  });
  app.define(def, {
    handle: async (inv) => ({
      kind: 'completed',
      output: { summary: `summary of ${JSON.stringify(inv.input)}` },
    }),
  });
  const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
  const inst = await app.createInstance(
    {
      definition: { id: 'summarizer', version: '1.0.0' },
      ownerId: 'bob',
      idempotencyKey: 's',
    },
    bob,
  );
  const server: A2AServer = createA2AServer(localAppTarget(app), {
    instanceId: inst.id,
  });
  const card = {
    ...agentCardForDefinition(def, `${BASE}/a2a`, { streaming: true }),
  };
  const seen: { method?: string; version: string | null }[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith(AGENT_CARD_PATH)) return Response.json(card);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { method?: string };
    const version = headers.get('a2a-version');
    seen.push({ method: body.method, version });
    const h = version ? { 'a2a-version': version } : {};
    if (headers.get('accept')?.includes('text/event-stream')) {
      const r = await server.stream(body, caller, h);
      if (r.kind === 'error')
        return Response.json(r.response.body, { status: r.response.status });
      const text = sseFrames(r.frames)[Symbol.asyncIterator]();
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const n = await text.next();
            if (n.done) controller.close();
            else controller.enqueue(enc.encode(n.value));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    const r = await server.handle(body, caller, h);
    return Response.json(r.body, { status: r.status });
  }) as typeof fetch;
  return { app, fetchImpl, seen };
}

/** The SDK's message shape (ts-proto: every field present). */
const sdkMessage = (
  messageId: string,
  text: string,
  extra: Partial<SdkMessage> = {},
): SdkMessage => ({
  messageId,
  contextId: '',
  taskId: '',
  role: Role.ROLE_USER,
  parts: [
    {
      content: { $case: 'text', value: text },
      metadata: undefined,
      filename: '',
      mediaType: 'application/json',
    },
  ],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
  ...extra,
});

const sendRequest = (message: SdkMessage) => ({
  tenant: '',
  message,
  configuration: undefined,
  metadata: undefined,
});

describe('A2A interop with the reference SDK (@a2a-js/sdk 1.3.0)', () => {
  it('the SDK client reads the AgentCard and runs SendMessage, GetTask and ListTasks against Agentropy', async () => {
    const p = await agentropyPeer();
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: p.fetchImpl })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: p.fetchImpl }),
    });
    const client = await factory.createFromUrl(BASE);
    const sent = await client.sendMessage(
      sendRequest(
        sdkMessage('m-1', JSON.stringify({ doc: 'q3' }), {
          contextId: 'ctx-1',
        }),
      ),
    );
    const task = sent as SdkTask;
    expect(task.id).toMatch(/^task-/);
    expect(task.contextId).toBe('ctx-1');
    expect(task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    await p.app.runUntilIdle();
    const done = await client.getTask({
      tenant: '',
      id: task.id,
      historyLength: undefined,
    });
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const part = done.artifacts[0]!.parts[0]!;
    expect(part.content).toEqual({
      $case: 'text',
      value: JSON.stringify({ summary: 'summary of {"doc":"q3"}' }),
    });
    const listed = await client.listTasks({
      tenant: '',
      contextId: 'ctx-1',
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: '',
      statusTimestampAfter: undefined,
      pageSize: undefined,
      historyLength: undefined,
      includeArtifacts: undefined,
    } as never);
    expect(listed.tasks.map((t) => t.id)).toEqual([task.id]);
    // Every call carried the protocol version.
    expect(p.seen.every((s) => s.version === A2A_PROTOCOL_VERSION)).toBe(true);
  });

  it('the SDK client streams SendStreamingMessage from Agentropy until the terminal status', async () => {
    const p = await agentropyPeer();
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: p.fetchImpl })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: p.fetchImpl }),
    });
    const client = await factory.createFromUrl(BASE);
    const events: string[] = [];
    const reading = (async () => {
      for await (const e of client.sendMessageStream(
        sendRequest(sdkMessage('m-s', JSON.stringify({ doc: 'q4' }))),
      )) {
        const r = e.payload;
        if (!r) continue;
        if (r.$case === 'task')
          events.push(`task:${TaskState[r.value.status!.state]}`);
        else if (r.$case === 'statusUpdate')
          events.push(`status:${TaskState[r.value.status!.state]}`);
        else events.push(r.$case);
      }
    })();
    await new Promise((r) => setTimeout(r, 20));
    await p.app.runUntilIdle();
    await reading;
    expect(events[0]).toBe('task:TASK_STATE_SUBMITTED');
    expect(events).toContain('artifactUpdate');
    expect(events.at(-1)).toBe('status:TASK_STATE_COMPLETED');
  });

  it('Agentropy’s A2A provider delegates to an SDK server and reads its result', async () => {
    const card = {
      name: 'SDK echo',
      description: 'echo',
      version: '1.0.0',
      supportedInterfaces: [
        {
          url: `${BASE}/a2a`,
          protocolBinding: 'JSONRPC',
          protocolVersion: A2A_PROTOCOL_VERSION,
          tenant: '',
        },
      ],
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [],
        extendedAgentCard: false,
      },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['application/json'],
      skills: [],
      signatures: [],
    } as unknown as SdkAgentCard;
    const received: SdkMessage[] = [];
    const executor: AgentExecutor = {
      execute: async (ctx, bus) => {
        received.push(ctx.userMessage);
        const content = ctx.userMessage.parts[0]?.content;
        const input = content?.$case === 'text' ? content.value : '';
        bus.publish({
          kind: 'task',
          data: {
            id: ctx.taskId,
            contextId: ctx.contextId,
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              message: undefined,
              timestamp: '2026-11-06T00:00:00.000Z',
            },
            artifacts: [
              {
                artifactId: 'out',
                name: '',
                description: '',
                parts: [
                  {
                    content: {
                      $case: 'text',
                      value: JSON.stringify({ echoed: JSON.parse(input) }),
                    },
                    metadata: undefined,
                    filename: '',
                    mediaType: 'application/json',
                  },
                ],
                metadata: undefined,
                extensions: [],
              },
            ],
            history: [],
            metadata: undefined,
          },
        });
        bus.finished();
      },
      cancelTask: async () => undefined,
    };
    const rpc = new JsonRpcTransportHandler(
      new DefaultRequestHandler(card, new InMemoryTaskStore(), executor),
    );
    const fetch = async (
      _url: string,
      init: { headers: Record<string, string>; body: string },
    ) => {
      const context = defaultServerCallContextBuilder({
        extensions: undefined,
        user: new UnauthenticatedUser(),
        headers: init.headers,
        requestedVersion: init.headers['a2a-version'],
      });
      const res = await rpc.handle(JSON.parse(init.body) as never, context);
      return {
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => res as unknown,
      };
    };
    const provider = new A2ACommunicationProvider({
      allowEndpoint: (u: URL) => u.origin === BASE,
      fetch,
      maxPolls: 3,
    });
    const route = {
      providerId: provider.id,
      protocol: 'a2a',
      protocolVersion: A2A_PROTOCOL_VERSION,
      target: {
        definitionId: 'echo',
        tenantId: 't-1',
        endpoint: `${BASE}/a2a`,
      },
    };
    const ctx = { caller, correlationId: 'c-1' };
    const ref = await provider.delegate(
      route,
      {
        target: {},
        input: { doc: 'q5' },
        idempotencyKey: 'k-1',
        correlationId: 'c-1',
      },
      ctx,
    );
    expect(received[0]).toMatchObject({
      messageId: 'k-1',
      contextId: 'c-1',
      role: Role.ROLE_USER,
    });
    expect(await provider.getTask(ref, ctx)).toMatchObject({
      remoteState: 'TASK_STATE_COMPLETED',
      normalized: 'completed',
      output: { echoed: { doc: 'q5' } },
    });
  });
});
