// FEAT-029.1: A2A 1.0 streaming. Inbound `SendStreamingMessage`/`SubscribeToTask` frames from a LocalApp, the
// outbound provider reading `SubscribeToTask` over SSE, and its polling fallback when a peer declines or a stream
// breaks. The transport is a fake fetch that serializes frames with `sseFrames` and re-chunks the bytes.
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type AgentEvent,
  type AgentRef,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  A2ACommunicationProvider,
  A2A_PROTOCOL_VERSION,
  DefaultCommunicationRouter,
  a2aAgentCard,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  sseFrames,
  type A2AServer,
  type A2AStreamFrame,
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

/** Re-chunks text into fixed-size byte slices (CRLF line ends) to exercise the SSE parser's buffering. */
async function* rechunk(
  text: AsyncIterable<string>,
  size: number,
): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  for await (const t of text) {
    const bytes = enc.encode(t.replace(/\n/g, '\r\n'));
    for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
  }
}

/** Fake HTTP with SSE: `accept: text/event-stream` goes to `server.stream`, everything else to `server.handle`. */
function sseTransport(
  server: A2AServer,
  tokens: Record<string, TrustedPrincipal>,
  o: { streams?: boolean; breakAfter?: number } = {},
) {
  const seen: { method: string; accept: string | undefined }[] = [];
  const fetch = async (
    _url: string,
    init: { headers: Record<string, string>; body: string },
  ) => {
    const body = JSON.parse(init.body) as { method: string };
    seen.push({ method: body.method, accept: init.headers.accept });
    const token = init.headers.authorization?.replace(/^Bearer /, '');
    const principal = token ? tokens[token] : undefined;
    const headers = { 'a2a-version': init.headers['a2a-version'] };
    if (o.streams !== false && init.headers.accept === 'text/event-stream') {
      const r = await server.stream(body, principal, headers);
      if (r.kind === 'error')
        return {
          status: r.response.status,
          headers: { get: () => 'application/json' },
          json: async () => r.response.body,
        };
      let frames: AsyncIterable<A2AStreamFrame> = r.frames;
      if (o.breakAfter !== undefined) {
        const limit = o.breakAfter;
        const inner = r.frames;
        frames = (async function* () {
          let n = 0;
          for await (const f of inner) {
            if (n++ === limit) throw new TypeError('socket hang up');
            yield f;
          }
        })();
      }
      return {
        status: 200,
        headers: { get: () => 'text/event-stream; charset=utf-8' },
        body: rechunk(sseFrames(frames), 7),
        json: async () => {
          throw new Error('not JSON');
        },
      };
    }
    const res = await server.handle(body, principal, headers);
    return {
      status: res.status,
      headers: { get: () => 'application/json' },
      json: async () => res.body,
    };
  };
  return { fetch, seen };
}

const credentials = { resolve: async () => ({ token: 'tok-a' }) };

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

async function peer() {
  const b = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
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
  const server = createA2AServer(localAppTarget(b), {
    instanceId: inst.id,
    now: () => '2026-11-06T00:00:00.000Z',
  });
  return { b, server };
}

const target: AgentRef = {
  definitionId: 'summarizer',
  tenantId: 't-1',
  endpoint: 'https://b.example/a2a',
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const kind = (f: A2AStreamFrame): string => {
  const r = f.result as Record<string, { status?: { state: string } }>;
  if (f.error) return `error:${f.error.code}`;
  if (r['task']) return `task:${r['task'].status!.state}`;
  if (r['statusUpdate']) return `status:${r['statusUpdate'].status!.state}`;
  return Object.keys(r)[0]!;
};

describe('A2A streaming, inbound', () => {
  it('SendStreamingMessage streams the task, forward-only status updates and the output artifact, then ends', async () => {
    const { b, server } = await peer();
    const r = await server.stream(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'SendStreamingMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'm-1',
            contextId: 'ctx-1',
            parts: [
              {
                text: JSON.stringify({ doc: 'q3' }),
                mediaType: 'application/json',
              },
            ],
          },
        },
      },
      caller,
      { 'a2a-version': A2A_PROTOCOL_VERSION },
    );
    if (r.kind !== 'stream') throw new Error('expected a stream');
    const frames = collect(r.frames);
    await b.runUntilIdle();
    const all = await frames;
    const kinds = all.map(kind);
    expect(kinds[0]).toBe('task:TASK_STATE_SUBMITTED');
    expect(kinds.slice(-2)).toEqual([
      'artifactUpdate',
      'status:TASK_STATE_COMPLETED',
    ]);
    // Forward-only: no state is reported after a later one, and none twice in a row.
    const states = kinds.filter(
      (k) => k.startsWith('status:') || k.startsWith('task:'),
    );
    expect(new Set(states).size).toBe(states.length);
    expect(all.every((f) => f.id === 7 && f.jsonrpc === '2.0')).toBe(true);
    const art = all.at(-2)!.result as {
      artifactUpdate: { taskId: string; contextId: string; artifact: unknown };
    };
    expect(art.artifactUpdate).toMatchObject({
      contextId: 'ctx-1',
      artifact: {
        parts: [
          {
            text: JSON.stringify({ summary: 'summary of q3' }),
            mediaType: 'application/json',
          },
        ],
      },
    });
  });

  it('SubscribeToTask: terminal tasks are UnsupportedOperation, unknown tasks NotFound; auth and method rules hold', async () => {
    const { b, server } = await peer();
    const sent = await server.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'm-2',
            parts: [{ text: '{"doc":"x"}', mediaType: 'application/json' }],
          },
        },
      },
      caller,
    );
    const taskId = (sent.body.result as { task: { id: string } }).task.id;
    await b.runUntilIdle();
    const sub = (id: string, p: TrustedPrincipal | null = caller) =>
      server.stream(
        { jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id } },
        p ?? undefined,
      );
    const terminal = await sub(taskId);
    expect(
      terminal.kind === 'error' && terminal.response.body.error?.code,
    ).toBe(-32004);
    const missing = await sub('nope');
    expect(missing.kind === 'error' && missing.response.body.error?.code).toBe(
      -32001,
    );
    const anon = await sub(taskId, null);
    expect(anon.kind === 'error' && anon.response.status).toBe(401);
    const otherTenant = await sub(taskId, { ...caller, tenantId: 't-2' });
    expect(
      otherTenant.kind === 'error' && otherTenant.response.body.error?.code,
    ).toBe(-32001);
    // Streaming methods need the streaming transport; unary methods are not streams.
    expect(
      (
        await server.handle(
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'SubscribeToTask',
            params: { id: taskId },
          },
          caller,
        )
      ).body.error?.code,
    ).toBe(-32004);
    const unary = await server.stream(
      { jsonrpc: '2.0', id: 4, method: 'GetTask', params: { id: taskId } },
      caller,
    );
    expect(unary.kind === 'error' && unary.response.body.error?.code).toBe(
      -32601,
    );
    const envelope = await server.stream(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'SendStreamingMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'm-3',
            parts: [{ text: 'x' }],
            metadata: { 'agentropy/envelope': {} },
          },
        },
      },
      caller,
    );
    expect(
      envelope.kind === 'error' && envelope.response.body.error?.code,
    ).toBe(-32004);
  });

  it('an event stream that ends early is reconciled with the task: the terminal state and output still arrive', async () => {
    const fake = new FakeDirectTarget();
    // A target whose event stream ends at once, as when the terminal event was compacted away.
    const server = createA2AServer({
      ...fake,
      delegate: (r, c) => fake.delegate(r, c),
      getTask: (id, c) => fake.getTask(id, c),
      cancel: (id, c) => fake.cancel(id, c),
      receive: (m) => fake.receive(m),
      subscribe: async function* () {},
    });
    const r = await server.stream(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'SendStreamingMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'm-9',
            parts: [{ text: 'go' }],
          },
        },
      },
      caller,
    );
    if (r.kind !== 'stream') throw new Error('expected a stream');
    const t = [...fake.tasks.values()][0]!;
    t.snapshot = {
      ...t.snapshot,
      status: 'completed',
      revision: 3,
      output: 'done',
    } as never;
    expect((await collect(r.frames)).map(kind)).toEqual([
      'task:TASK_STATE_SUBMITTED',
      'artifactUpdate',
      'status:TASK_STATE_COMPLETED',
    ]);
  });

  it('sseFrames writes one data event per frame', async () => {
    const out = await collect(
      sseFrames(
        (async function* () {
          yield { jsonrpc: '2.0' as const, id: 1, result: { a: 1 } };
        })(),
      ),
    );
    expect(out).toEqual([
      'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n',
    ]);
  });

  it('the AgentCard advertises streaming only when asked', () => {
    const card = (streaming?: boolean) =>
      a2aAgentCard({
        name: 'S',
        description: 'd',
        version: '1.0.0',
        url: 'https://b.example/a2a',
        ...(streaming === undefined ? {} : { streaming }),
      })['capabilities'];
    expect(card()).toEqual({ streaming: false, pushNotifications: false });
    expect(card(true)).toEqual({ streaming: true, pushNotifications: false });
  });
});

describe('A2A streaming, outbound', () => {
  async function setup(o: { streams?: boolean; breakAfter?: number } = {}) {
    const p = await peer();
    const t = sseTransport(p.server, { 'tok-a': caller }, o);
    const a2a = new A2ACommunicationProvider({
      fetch: t.fetch,
      credentialRef: 'peer-b',
      credentials,
      streaming: true,
      pollMs: 1,
      maxPolls: 50,
    });
    const router = new DefaultCommunicationRouter();
    router.register(a2a);
    const ctx = { caller, correlationId: 'c-1' };
    const route = await router.selectRoute(target, 'delegate', ctx);
    const ref = await a2a.delegate(
      route,
      {
        target: {},
        input: { doc: 'q3' },
        idempotencyKey: 'k-1',
        correlationId: 'c-1',
      },
      ctx,
    );
    return { ...p, ...t, a2a, ctx, ref };
  }
  const states = (es: AgentEvent[]) =>
    es.map((e) => (e.payload as { remoteState: string }).remoteState);

  it('subscribe reads SubscribeToTask over SSE until the terminal state', async () => {
    const s = await setup();
    expect(s.a2a.features.streaming).toBe(true);
    const events = collect(s.a2a.subscribe(s.ref, s.ctx));
    await s.b.runUntilIdle();
    const es = await events;
    expect(states(es)[0]).toBe('TASK_STATE_SUBMITTED');
    expect(states(es).at(-1)).toBe('TASK_STATE_COMPLETED');
    expect(es.map((e) => e.revision)).toEqual(es.map((_, i) => i + 1));
    expect(s.seen.filter((r) => r.method === 'SubscribeToTask')).toEqual([
      { method: 'SubscribeToTask', accept: 'text/event-stream' },
    ]);
    expect(s.seen.some((r) => r.method === 'GetTask')).toBe(false);
  });

  it('falls back to polling GetTask when the peer does not stream', async () => {
    const s = await setup({ streams: false });
    await s.b.runUntilIdle();
    const es = await collect(s.a2a.subscribe(s.ref, s.ctx));
    expect(states(es)).toEqual(['TASK_STATE_COMPLETED']);
    expect(s.seen.map((r) => r.method)).toEqual([
      'SendMessage',
      'SubscribeToTask',
      'GetTask',
    ]);
  });

  it('falls back to polling when the stream breaks, continuing revisions without repeating a state', async () => {
    const s = await setup({ breakAfter: 1 });
    const events = collect(s.a2a.subscribe(s.ref, s.ctx));
    await s.b.runUntilIdle();
    const es = await events;
    expect(states(es)[0]).toBe('TASK_STATE_SUBMITTED');
    expect(states(es).at(-1)).toBe('TASK_STATE_COMPLETED');
    expect(new Set(states(es)).size).toBe(es.length);
    expect(es.map((e) => e.revision)).toEqual(es.map((_, i) => i + 1));
    expect(s.seen.some((r) => r.method === 'GetTask')).toBe(true);
  });

  it('a subscription to an already-finished task polls once; an unknown task is NotFound, not a fallback', async () => {
    const s = await setup();
    await s.b.runUntilIdle();
    expect(states(await collect(s.a2a.subscribe(s.ref, s.ctx)))).toEqual([
      'TASK_STATE_COMPLETED',
    ]);
    expect(
      await code(
        collect(
          s.a2a.subscribe(
            { ...s.ref, remoteTaskId: 'nope', localTaskId: 'a2a:nope' },
            s.ctx,
          ),
        ),
      ),
    ).toBe('NotFound');
  });

  it('rejects oversized SSE events', async () => {
    const huge = 'x'.repeat((1 << 20) + 10);
    const a2a = new A2ACommunicationProvider({
      streaming: true,
      fetch: async () => ({
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: (async function* () {
          yield `data: ${huge}`;
        })(),
        json: async () => ({}),
      }),
    });
    const ref = {
      localTaskId: 'a2a:t',
      remoteTaskId: 't',
      route: { target, providerId: 'a2a' } as never,
    };
    expect(
      await code(collect(a2a.subscribe(ref, { caller, correlationId: 'c' }))),
    ).toBe('SchemaViolation');
  });
});

defineCommunicationConformance(
  { describe, it, expect },
  'a2a (streaming)',
  () => {
    const fake = new FakeDirectTarget();
    const { fetch } = sseTransport(createA2AServer(fake), { 'tok-a': caller });
    const provider = new A2ACommunicationProvider({
      fetch,
      credentialRef: 'peer-b',
      credentials,
      streaming: true,
      maxPolls: 0,
      now: () => '2026-11-06T00:00:00.000Z',
    });
    const router = new DefaultCommunicationRouter();
    router.register(provider);
    return {
      router,
      provider,
      target: { ...target, definitionId: 'worker', version: '1.0.0' },
      caller,
      received: () => fake.received,
    };
  },
);
