// FEAT-034.1: the A2A HTTP binding on a real loopback socket. JSON-RPC POST, SSE streaming, the well-known
// AgentCard, principal mapping from a bearer token, and the request-level guards (method, content type, size,
// parse errors, stream bound). The Agentropy A2A client talks to it over real fetch as a second peer would.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A2ACommunicationProvider,
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  agentCardForDefinition,
  createA2AHttpHandler,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type A2AHttpHandler,
} from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy, allowNetwork } from '../src/index.js';

const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
const caller: TrustedPrincipal = {
  id: 'svc-a',
  type: 'service',
  tenantId: 't-1',
};

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

/**
 * Minimal fetch over node:http. The offline network guard keeps the global `fetch` blocked and lets TCP through
 * only to allowed endpoints, so the tests speak HTTP through a plain socket.
 */
interface LoopbackResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
function fetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: init.method ?? 'GET', headers: init.headers ?? {} },
      (res) => {
        const text = async () => {
          let out = '';
          for await (const c of res) out += String(c);
          return out;
        };
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (n) => {
              const v = res.headers[n.toLowerCase()];
              return v === undefined ? null : String(v);
            },
          },
          body: res,
          text,
          json: async () => JSON.parse(await text()) as unknown,
        });
      },
    );
    init.signal?.addEventListener('abort', () => req.destroy());
    req.on('error', reject);
    req.end(init.body);
  });
}

const open: { server: Server; release: () => void }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.server.closeAllConnections();
    await new Promise((r) => o.server.close(r));
    o.release();
  }
});

/** A LocalApp exposed over HTTP on 127.0.0.1; `gate` holds the handler until opened. */
async function host(o: { maxBodyBytes?: number; maxStreams?: number } = {}) {
  let open_!: () => void;
  let gate = new Promise<void>((r) => (open_ = r));
  const app = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
    profiles: BUILTIN_PROFILES,
  });
  app.define(def, {
    handle: async (inv) => {
      await gate;
      return {
        kind: 'completed',
        output: { summary: `summary of ${(inv.input as { doc: string }).doc}` },
      };
    },
  });
  const inst = await app.createInstance(
    {
      definition: { id: 'summarizer', version: '1.0.0' },
      ownerId: 'bob',
      idempotencyKey: 's',
    },
    bob,
  );
  const a2a = createA2AServer(localAppTarget(app), { instanceId: inst.id });
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const http: A2AHttpHandler = createA2AHttpHandler(a2a, {
    authenticate: async (req) =>
      req.headers.authorization === 'Bearer tok-a' ? caller : undefined,
    agentCard: agentCardForDefinition(def, `${base}/a2a`),
    ...o,
  });
  server.on('request', (req, res) => {
    void http.handle(req, res).then((served) => {
      if (!served) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  open.push({ server, release: allowNetwork([`127.0.0.1:${port}`]) });
  return {
    app,
    base,
    http,
    release: () => open_(),
    rearm: () => (gate = new Promise<void>((r) => (open_ = r))),
  };
}

const rpc = (method: string, params: unknown, id: unknown = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });

const message = (messageId: string, doc: string) => ({
  message: {
    role: 'ROLE_USER',
    messageId,
    parts: [{ text: JSON.stringify({ doc }), mediaType: 'application/json' }],
  },
});

const post = (
  base: string,
  body: string,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}/a2a`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer tok-a',
      'a2a-version': A2A_PROTOCOL_VERSION,
      ...headers,
    },
    body,
  });

/** SSE `data:` payloads of a response body, parsed. */
async function events(res: LoopbackResponse) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((e) => e.startsWith('data: '))
    .map((e) => JSON.parse(e.slice(6)) as Record<string, unknown>);
}

describe('A2A HTTP binding (FEAT-034.1)', () => {
  it('serves the AgentCard at the well-known path and leaves other paths to the host', async () => {
    const h = await host();
    const card = await fetch(`${h.base}${AGENT_CARD_PATH}`);
    expect(card.status).toBe(200);
    expect(card.headers.get('content-type')).toContain('application/json');
    const body = (await card.json()) as {
      name: string;
      supportedInterfaces: { url: string; protocolBinding: string }[];
    };
    expect(body.name).toBe('Summarizer');
    expect(body.supportedInterfaces[0]).toMatchObject({
      url: `${h.base}/a2a`,
      protocolBinding: 'JSONRPC',
    });
    expect((await fetch(`${h.base}/healthz`)).status).toBe(404);
    expect(
      (await fetch(`${h.base}${AGENT_CARD_PATH}`, { method: 'POST' })).status,
    ).toBe(405);
  });

  it('SendMessage and GetTask over JSON-RPC POST, as the authenticated principal', async () => {
    const h = await host();
    h.release();
    const sent = await post(h.base, rpc('SendMessage', message('m-1', 'q3')));
    expect(sent.status).toBe(200);
    const { result } = (await sent.json()) as {
      result: { task: { id: string; status: { state: string } } };
    };
    expect(result.task.status.state).toBe('TASK_STATE_SUBMITTED');
    await h.app.runUntilIdle();
    const got = (await (
      await post(h.base, rpc('GetTask', { id: result.task.id }, 2))
    ).json()) as {
      id: number;
      result: { status: { state: string }; artifacts: unknown[] };
    };
    expect(got.id).toBe(2);
    expect(got.result.status.state).toBe('TASK_STATE_COMPLETED');
    expect(got.result.artifacts).toHaveLength(1);
    // The task was accepted for the principal the token maps to, not for anything in the body.
    const task = await h.app.getTask(result.task.id, caller);
    expect(task.status).toBe('completed');
  });

  it('rejects requests it cannot serve: no credentials, wrong method, content type, size, malformed JSON', async () => {
    const h = await host({ maxBodyBytes: 512 });
    const anon = await post(h.base, rpc('GetTask', { id: 'x' }), {
      authorization: '',
    });
    expect(anon.status).toBe(401);
    expect(
      ((await anon.json()) as { error: { code: number } }).error.code,
    ).toBe(-32600);
    expect((await fetch(`${h.base}/a2a`)).status).toBe(405);
    const text = await post(h.base, rpc('GetTask', { id: 'x' }), {
      'content-type': 'text/plain',
    });
    expect(text.status).toBe(415);
    expect(
      ((await text.json()) as { error: { code: number } }).error.code,
    ).toBe(-32005);
    const big = await post(
      h.base,
      rpc('SendMessage', message('m-big', 'x'.repeat(2000))),
    );
    expect(big.status).toBe(413);
    const bad = await post(h.base, '{"jsonrpc": "2.0",');
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(
      -32700,
    );
    const version = await post(h.base, rpc('GetTask', { id: 'x' }), {
      'a2a-version': '0.2',
    });
    expect(
      ((await version.json()) as { error: { code: number } }).error.code,
    ).toBe(-32009);
  });

  it('SendStreamingMessage answers text/event-stream and ends after the terminal status', async () => {
    const h = await host();
    const res = post(
      h.base,
      rpc('SendStreamingMessage', message('m-s', 'q4'), 'stream-1'),
      { accept: 'text/event-stream' },
    );
    await new Promise((r) => setTimeout(r, 20));
    h.release();
    await h.app.runUntilIdle();
    const r = await res;
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const frames = await events(r);
    expect(frames.every((f) => f['id'] === 'stream-1')).toBe(true);
    const results = frames.map((f) => f['result'] as Record<string, unknown>);
    expect(Object.keys(results[0]!)).toEqual(['task']);
    const last = results.at(-1) as {
      statusUpdate: { status: { state: string } };
    };
    expect(last.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
    expect(results.some((x) => 'artifactUpdate' in x)).toBe(true);
    expect(h.http.openStreams()).toBe(0);
  });

  it('bounds open streams; a stream whose client left is released at the task’s next event', async () => {
    const h = await host({ maxStreams: 1 });
    const abort = new AbortController();
    const first = await fetch(`${h.base}/a2a`, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok-a',
        accept: 'text/event-stream',
      },
      body: rpc('SendStreamingMessage', message('m-1', 'a')),
    });
    expect(first.status).toBe(200);
    expect(h.http.openStreams()).toBe(1);
    const refused = await post(
      h.base,
      rpc('SendStreamingMessage', message('m-2', 'b')),
    );
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('1');
    abort.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.http.openStreams()).toBe(1); // still waiting for the task's next event
    h.release();
    await h.app.runUntilIdle();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.http.openStreams()).toBe(0);
  });

  it('the Agentropy A2A client delegates to it over real HTTP', async () => {
    const h = await host();
    h.release();
    const provider = new A2ACommunicationProvider({
      credentialRef: 'peer',
      credentials: { resolve: async () => ({ token: 'tok-a' }) },
      fetch,
    });
    const route = {
      providerId: provider.id,
      protocol: 'a2a',
      protocolVersion: A2A_PROTOCOL_VERSION,
      target: {
        definitionId: 'summarizer',
        tenantId: 't-1',
        endpoint: `${h.base}/a2a`,
      },
    };
    const ctx = { caller, correlationId: 'c-5' };
    const ref = await provider.delegate(
      route,
      {
        target: {},
        input: { doc: 'q5' },
        idempotencyKey: 'k-5',
        correlationId: 'c-5',
      },
      ctx,
    );
    await h.app.runUntilIdle();
    expect(await provider.getTask(ref, ctx)).toMatchObject({
      normalized: 'completed',
      output: { summary: 'summary of q5' },
    });
  });
});
