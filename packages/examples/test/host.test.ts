// FEAT-028.8: container host — health and readiness answers, default-deny sample policy, no error details on the
// unauthenticated port. The handler is called directly (the suite runs without sockets).
import { BUILTIN_PROFILES, type TrustedPrincipal } from '@agentropy/core';
import { createLocalApp } from '@agentropy/runtime';
import { SqliteStore } from '@agentropy/store-sqlite';
import {
  createServer,
  get,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { allowNetwork } from '@agentropy/testkit';
import { describe, expect, it, vi } from 'vitest';
import {
  AllowListPolicy,
  a2aEndpoint,
  bearerTokens,
  defineAgents,
  healthHandler,
  hostRequestListener,
  schedulerStalled,
  tokenPrincipals,
  isMainModule,
  main,
  parseHostEnv,
  shutdownHost,
  startCompaction,
  telemetryFromEnv,
} from '../src/host.js';

function call(
  handler: ReturnType<typeof healthHandler>,
  method: string,
  url: string,
) {
  return new Promise<{ status: number; body: unknown }>((resolve) => {
    let status = 0;
    const res = {
      writeHead: (s: number) => {
        status = s;
        return res;
      },
      end: (body: string) => resolve({ status, body: JSON.parse(body) }),
    } as unknown as ServerResponse;
    void handler({ method, url } as IncomingMessage, res);
  });
}

describe('container host (M3-08)', () => {
  it('answers liveness and readiness, and refuses readiness while shutting down or without a store', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const app = createLocalApp({
      store,
      pdp: new AllowListPolicy(''),
      profiles: BUILTIN_PROFILES,
    });
    const state = { shuttingDown: false };
    const h = healthHandler(app, state);
    expect(await call(h, 'GET', '/healthz')).toEqual({
      status: 200,
      body: { status: 'ok' },
    });
    expect((await call(h, 'GET', '/readyz')).status).toBe(200);
    expect((await call(h, 'POST', '/readyz')).status).toBe(405);
    expect((await call(h, 'GET', '/metrics')).status).toBe(404);
    state.shuttingDown = true;
    expect((await call(h, 'GET', '/readyz')).status).toBe(503);
    state.shuttingDown = false;
    await store.close();
    expect(await call(h, 'GET', '/readyz')).toEqual({
      status: 503,
      body: { status: 'store-unavailable' },
    });
  });

  it('A2A endpoint: off without tokens; bearer tokens map to principals of one tenant; the card names the endpoint', async () => {
    const app = createLocalApp({
      store: new SqliteStore({ path: ':memory:' }),
      pdp: new AllowListPolicy('agent:create,agent:share'),
      profiles: BUILTIN_PROFILES,
    });
    defineAgents(app);
    expect(await a2aEndpoint(app, {})).toBeUndefined();
    const auth = bearerTokens(' s3cret=peer-a, other=peer-b ', 'acme');
    const req = (authorization?: string) =>
      ({ headers: authorization ? { authorization } : {} }) as IncomingMessage;
    expect(await auth(req('Bearer s3cret'))).toEqual({
      id: 'peer-a',
      type: 'user',
      tenantId: 'acme',
    });
    expect(await auth(req('Bearer other'))).toMatchObject({ id: 'peer-b' });
    expect(await auth(req('Bearer wrong'))).toBeUndefined();
    expect(await auth(req('s3cret'))).toBeUndefined();
    expect(await auth(req())).toBeUndefined();
    expect(() => bearerTokens('no-principal', 't')).toThrow(
      /token=principalId/,
    );

    const a2a = (await a2aEndpoint(app, {
      AGENTROPY_A2A_TOKENS: 's3cret=peer-a',
      AGENTROPY_PUBLIC_URL: 'https://agents.example',
    }))!;
    const card = await new Promise<{ status: number; body: unknown }>(
      (resolve) => {
        let status = 0;
        const res = {
          writeHead: (s: number) => {
            status = s;
            return res;
          },
          end: (body: string) => resolve({ status, body: JSON.parse(body) }),
        } as unknown as ServerResponse;
        void a2a.handle(
          {
            method: 'GET',
            url: '/.well-known/agent-card.json',
            headers: {},
          } as IncomingMessage,
          res,
        );
      },
    );
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({
      name: 'Echo',
      supportedInterfaces: [{ url: 'https://agents.example/a2a' }],
      security: [{ bearer: [] }],
    });
    // Paths it does not serve fall through to the health handler.
    expect(
      await a2a.handle(
        { method: 'GET', url: '/healthz', headers: {} } as IncomingMessage,
        {} as ServerResponse,
      ),
    ).toBe(false);
  });

  it('the sample policy denies everything not explicitly allowed', async () => {
    const alice: TrustedPrincipal = { id: 'a', type: 'user', tenantId: 't' };
    const closed = createLocalApp({
      store: new SqliteStore({ path: ':memory:' }),
      pdp: new AllowListPolicy('agent:create'),
      profiles: BUILTIN_PROFILES,
    });
    defineAgents(closed);
    const inst = await closed.createInstance(
      {
        definition: { id: 'echo', version: '1.0.0' },
        ownerId: 'a',
        idempotencyKey: 'i',
      },
      alice,
    );
    const denied = await closed
      .delegate(
        {
          target: { instanceId: inst.id },
          input: {},
          idempotencyKey: 'k',
          correlationId: 'c',
        },
        alice,
      )
      .catch((e: { code: string }) => e.code);
    expect(denied).toBe('PermissionDenied');
    expect(
      await new AllowListPolicy(' delegation:delegate , task:dispatch').decide({
        principal: alice,
        action: 'task:dispatch',
        resource: { type: 'task', id: 'x', tenantId: 't' },
      }),
    ).toEqual({ effect: 'allow' });
  });

  it('readiness drops when the scheduler loop is stalled or keeps failing', async () => {
    const app = createLocalApp({
      store: new SqliteStore({ path: ':memory:' }),
      pdp: new AllowListPolicy(''),
      profiles: BUILTIN_PROFILES,
    });
    const base = { running: true, consecutiveFailures: 0, intervalMs: 250 };
    const t0 = Date.parse('2026-11-06T00:00:00Z');
    expect(schedulerStalled({ ...base, running: false }, t0)).toBe(false);
    expect(
      schedulerStalled(
        {
          ...base,
          startedAt: '2026-11-06T00:00:00Z',
          lastTickAt: '2026-11-06T00:00:00Z',
        },
        t0 + 10_000,
      ),
    ).toBe(false);
    expect(
      schedulerStalled(
        {
          ...base,
          startedAt: '2026-11-06T00:00:00Z',
          lastTickAt: '2026-11-06T00:00:00Z',
        },
        t0 + 31_000,
      ),
    ).toBe(true);
    expect(
      schedulerStalled(
        { ...base, consecutiveFailures: 3, lastTickAt: '2026-11-06T00:00:00Z' },
        t0,
      ),
    ).toBe(true);
    // An app whose loop never started is ready: only a started loop can be stalled.
    expect(
      (
        await call(
          healthHandler(app, { shuttingDown: false }),
          'GET',
          '/readyz',
        )
      ).status,
    ).toBe(200);
  });

  it('shutdown cuts open streams, stops the scheduler, then closes the store, and is safe twice', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const app = createLocalApp({
      store,
      pdp: new AllowListPolicy(''),
      profiles: BUILTIN_PROFILES,
    });
    const order: string[] = [];
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n'); // a stream that never ends by itself
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const release = allowNetwork([`127.0.0.1:${port}`]);
    const cut = new Promise<void>((resolve) => {
      get(`http://127.0.0.1:${port}/`, (res) => {
        res.on('data', () => undefined);
        res.on('close', () => {
          order.push('stream cut');
          resolve();
        });
      }).on('error', () => undefined);
    });
    await vi.waitFor(() =>
      expect(server.listening && order.length === 0).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 50)); // the request reached the server
    const state = { shuttingDown: false };
    const stop = vi.fn(async () => {
      order.push('scheduler stopped');
    });
    const close = store.close.bind(store);
    store.close = async () => {
      order.push('store closed');
      return close();
    };
    await shutdownHost({ state, server, stop, app });
    await cut;
    await shutdownHost({ state, server, stop, app }); // second call is a no-op
    release();
    expect(state.shuttingDown).toBe(true);
    expect(server.listening).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(order).toContain('stream cut');
    expect(order.filter((x) => x !== 'stream cut')).toEqual([
      'scheduler stopped',
      'store closed',
    ]);
  });

  it('FEAT-072: an execution still running at the drain bound is aborted, its lease expired, and shutdown completes', async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'agentropy-drain-')),
      'host.db',
    );
    const store = new SqliteStore({ path });
    const alice: TrustedPrincipal = { id: 'a', type: 'user', tenantId: 't' };
    const policy = () =>
      new AllowListPolicy(
        'agent:create,delegation:delegate,task:dispatch,capability:notification:use',
      );
    const definition = {
      id: 'stuck',
      version: '1.0.0',
      displayName: 'stuck',
      profile: { id: 'task', version: '1.0.0' },
      implementation: {
        providerId: 'native-ts',
        providerVersion: '1.0.0',
        artifact: { id: 'stuck', version: '1.0.0' },
      },
      inputSchema: true,
      runtimeRequirements: { guarantees: [] },
      policyRef: { id: 'default', version: '1.0.0' },
    } as const;
    const app = createLocalApp({
      store,
      pdp: policy(),
      profiles: BUILTIN_PROFILES,
      runtime: { workerId: 'pod-1' },
    });
    let aborted = false;
    app.define(definition, {
      // Never returns, whatever the signal says: the pod would be killed while it still runs.
      handle: (_inv, ctx) =>
        new Promise(() => {
          ctx.signal.addEventListener('abort', () => (aborted = true));
        }),
    });
    const inst = await app.createInstance(
      {
        definition: { id: 'stuck', version: '1.0.0' },
        ownerId: 'a',
        idempotencyKey: 'i',
      },
      alice,
    );
    const handle = await app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'k',
      },
      alice,
    );
    const stop = app.start(5);
    const running = () =>
      store.transaction((tx) =>
        tx.find<{ state: string; leaseExpiresAt?: string }>('executions', {
          where: { state: 'running' },
        }),
      );
    await vi.waitFor(async () => expect(await running()).toHaveLength(1));

    const state = { shuttingDown: false };
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const began = Date.now();
    await shutdownHost({ state, server, stop, app, drainMs: 60 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(aborted).toBe(true);

    // The execution is still the pool's on paper, but its lease ran out at once, so another replica takes it over.
    const other = new SqliteStore({ path });
    const [exec] = await other.transaction((tx) =>
      tx.find<{ state: string; leaseExpiresAt: string }>('executions', {}),
    );
    expect(exec!.value.state).toBe('running');
    expect(Date.parse(exec!.value.leaseExpiresAt)).toBeLessThanOrEqual(
      Date.now(),
    );
    const replica = createLocalApp({
      store: other,
      pdp: policy(),
      profiles: BUILTIN_PROFILES,
      runtime: { workerId: 'pod-2' },
    });
    replica.define(definition, {
      handle: async () => ({ kind: 'completed', output: 'resumed' }),
    });
    await replica.runUntilIdle();
    expect(await replica.getResult(handle.taskId, alice)).toBe('resumed');
    await other.close();
  });

  it('A2A peers see and cancel only their own tasks; they are not tenant-wide services (TASK-035.1)', async () => {
    const app = createLocalApp({
      store: new SqliteStore({
        path: join(mkdtempSync(join(tmpdir(), 'agentropy-host-')), 'host.db'),
      }),
      pdp: new AllowListPolicy(
        'agent:create,agent:share,delegation:delegate,delegation:cancel,task:dispatch,capability:notification:use',
      ),
      profiles: BUILTIN_PROFILES,
    });
    defineAgents(app);
    const spec = 'tok-a=peer-a,tok-b=peer-b';
    expect(tokenPrincipals(spec)).toEqual(['peer-a', 'peer-b']);
    const a2a = (await a2aEndpoint(app, {
      AGENTROPY_A2A_TOKENS: spec,
      AGENTROPY_TENANT: 'acme',
    }))!;
    const rpc = async (token: string, method: string, params: unknown) => {
      const req = Object.assign(
        Readable.from([
          Buffer.from(
            JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          ),
        ]),
        {
          method: 'POST',
          url: '/a2a',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
        },
      ) as unknown as IncomingMessage;
      return new Promise<{
        result?: { task?: { id: string }; id?: string; tasks?: unknown[] };
        error?: { code: number };
      }>((resolve) => {
        const res = {
          writeHead: () => res,
          end: (body: string) => resolve(JSON.parse(body)),
        } as unknown as ServerResponse;
        void a2a.handle(req, res);
      });
    };
    const sent = await rpc('tok-a', 'SendMessage', {
      message: { role: 'ROLE_USER', messageId: 'm-1', parts: [{ text: 'hi' }] },
    });
    const taskId = sent.result.task.id as string;
    expect((await rpc('tok-a', 'GetTask', { id: taskId })).result.id).toBe(
      taskId,
    );
    // Another peer in the same tenant: the task does not exist for it, and neither can it cancel it.
    expect((await rpc('tok-b', 'GetTask', { id: taskId })).error?.code).toBe(
      -32001,
    );
    expect((await rpc('tok-b', 'CancelTask', { id: taskId })).error?.code).toBe(
      -32001,
    );
    expect((await rpc('tok-b', 'ListTasks', {})).result.tasks).toEqual([]);
    expect((await rpc('tok-a', 'ListTasks', {})).result.tasks).toHaveLength(1);
  });

  it('exports spans and metrics to an OTLP/HTTP collector when AGENTROPY_OTLP_ENDPOINT is set, and loads nothing without it (FEAT-037.3)', async () => {
    const off = await telemetryFromEnv({}, async () => {
      throw new Error('must not load');
    });
    expect(off.telemetry).toBeUndefined();

    const received: { path: string; body: string }[] = [];
    const collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    const port = (collector.address() as AddressInfo).port;
    const release = allowNetwork([`127.0.0.1:${port}`]);
    const on = await telemetryFromEnv({
      AGENTROPY_OTLP_ENDPOINT: `http://127.0.0.1:${port}/`,
      AGENTROPY_SERVICE_NAME: 'host-under-test',
      HOSTNAME: 'pod-9',
    });
    const span = on.telemetry!.startSpan('agentropy.test.span');
    span.end();
    on.telemetry!.count('agentropy.test.counter', 3, { kind: 'probe' });
    await on.shutdown(); // flushes both exporters
    release();
    await new Promise((r) => collector.close(r));
    const traces = received.find((r) => r.path === '/v1/traces');
    const meters = received.find((r) => r.path === '/v1/metrics');
    expect(traces?.body).toContain('agentropy.test.span');
    expect(traces?.body).toContain('host-under-test');
    expect(traces?.body).toContain('pod-9');
    expect(meters?.body).toContain('agentropy.test.counter');
  });

  it('/readyz reports rows a failing outbox consumer holds back as a detail, and stays ready', async () => {
    const app = createLocalApp({
      store: new SqliteStore({
        path: join(mkdtempSync(join(tmpdir(), 'agentropy-host-')), 'host.db'),
      }),
      pdp: new AllowListPolicy(
        'agent:create,agent:share,delegation:delegate,task:dispatch,capability:notification:use',
      ),
      profiles: BUILTIN_PROFILES,
    });
    defineAgents(app);
    const alice: TrustedPrincipal = { id: 'a', type: 'user', tenantId: 't' };
    const inst = await app.createInstance(
      {
        definition: { id: 'echo', version: '1.0.0' },
        ownerId: 'a',
        idempotencyKey: 'i',
      },
      alice,
    );
    await app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
    );
    const h = healthHandler(app, { shuttingDown: false });
    expect(await call(h, 'GET', '/readyz')).toEqual({
      status: 200,
      body: { status: 'ready' },
    });
    app.relay.register({
      id: 'broken',
      handle: async () => {
        throw new Error('down');
      },
    });
    for (let i = 0; i < 5; i++) await app.relay.drain();
    expect(await call(h, 'GET', '/readyz')).toEqual({
      status: 200,
      body: { status: 'ready', outboxStuck: 1 },
    });
  });

  it('FEAT-075: /readyz reports auditStuck while the audit sink refuses, and stays ready', async () => {
    let refusing = true;
    const app = createLocalApp({
      store: new SqliteStore({
        path: join(mkdtempSync(join(tmpdir(), 'agentropy-host-')), 'host.db'),
      }),
      pdp: new AllowListPolicy(
        'agent:create,delegation:delegate,task:dispatch,capability:notification:use',
      ),
      profiles: BUILTIN_PROFILES,
      audit: {
        record: async () => {
          if (refusing) throw new Error('sink down');
        },
      },
    });
    defineAgents(app);
    const alice: TrustedPrincipal = { id: 'a', type: 'user', tenantId: 't' };
    const inst = await app.createInstance(
      {
        definition: { id: 'echo', version: '1.0.0' },
        ownerId: 'a',
        idempotencyKey: 'i',
      },
      alice,
    );
    await app.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
    );
    const h = healthHandler(app, { shuttingDown: false });
    expect((await call(h, 'GET', '/readyz')).body).toEqual({ status: 'ready' });
    for (let i = 0; i < 5; i++) await app.auditForwarder!.drain();
    expect(await call(h, 'GET', '/readyz')).toEqual({
      status: 200,
      body: { status: 'ready', auditStuck: 1 },
    });
    refusing = false;
    await app.auditForwarder!.drain();
    expect((await call(h, 'GET', '/readyz')).body).toEqual({ status: 'ready' });
  });

  it('a request whose handler rejects is answered 500 and never becomes an unhandled rejection (FIX-049)', async () => {
    const answer = (headersSent: boolean) => {
      const seen: { status?: number; body?: string; destroyed?: boolean } = {};
      const res = {
        headersSent,
        writeHead: (status: number) => {
          seen.status = status;
          return res;
        },
        end: (body?: string) => {
          if (body !== undefined) seen.body = body;
        },
        destroy: () => {
          seen.destroyed = true;
        },
      } as unknown as ServerResponse;
      return { res, seen };
    };
    const req = { method: 'GET', url: '/a2a' } as IncomingMessage;
    const logged: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((line) => {
      logged.push(String(line));
    });
    try {
      const failing = {
        handle: async () => {
          throw new Error('secret detail');
        },
        openStreams: () => 0,
      };
      const health = vi.fn(async () => undefined);
      const listener = hostRequestListener(failing, health);
      const fresh = answer(false);
      await listener(req, fresh.res);
      expect(fresh.seen.status).toBe(500);
      expect(fresh.seen.body).toBe('{"error":"internal error"}');
      // A response that already started cannot be answered again: its connection is cut.
      const started = answer(true);
      await listener(req, started.res);
      expect(started.seen.status).toBeUndefined();
      expect(started.seen.destroyed).toBe(true);
      expect(health).not.toHaveBeenCalled();
      // One line per failure, without the error's message.
      expect(logged).toHaveLength(2);
      expect(logged.join()).not.toContain('secret detail');
      expect(JSON.parse(logged[0]!)).toMatchObject({
        level: 'error',
        event: 'http.request',
      });
      // A handler that does not serve the path leaves it to the health handler; one that does ends there.
      const passing = hostRequestListener(
        { handle: async () => false, openStreams: () => 0 },
        health,
      );
      await passing(req, answer(false).res);
      expect(health).toHaveBeenCalledTimes(1);
      const served = hostRequestListener(
        { handle: async () => true, openStreams: () => 0 },
        health,
      );
      await served(req, answer(false).res);
      await hostRequestListener(undefined, health)(req, answer(false).res);
      expect(health).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });
});

describe('host settings, main module and compaction schedule (FEAT-073)', () => {
  it('FEAT-073: a non-numeric setting stops the start with InvalidConfiguration, before anything is opened', async () => {
    for (const [name, value] of [
      ['AGENTROPY_TICK_MS', 'abc'],
      ['AGENTROPY_TICK_MS', '0'],
      ['AGENTROPY_TICK_MS', '2.5'],
      ['PORT', 'http'],
      ['PORT', '70000'],
      ['AGENTROPY_OUTBOX_POISON_AFTER', '-1'],
      ['AGENTROPY_COMPACT_EVERY_MS', 'daily'],
      ['AGENTROPY_COMPACT_RETAIN_MS', '-5'],
      ['AGENTROPY_DRAIN_MS', 'soon'],
    ] as const) {
      const env = { AGENTROPY_DB: ':memory:', [name]: value };
      expect(() => parseHostEnv(env), `${name}=${value}`).toThrow(
        expect.objectContaining({ code: 'InvalidConfiguration' }),
      );
      await expect(main(env)).rejects.toMatchObject({
        code: 'InvalidConfiguration',
      });
    }
    expect(parseHostEnv({})).toMatchObject({
      tickMs: 250,
      port: 8080,
      drainMs: 20_000,
    });
    expect(parseHostEnv({}).compaction).toBeUndefined();
    expect(
      parseHostEnv({
        AGENTROPY_TICK_MS: '50',
        PORT: '0',
        AGENTROPY_COMPACT_EVERY_MS: '3600000',
      }),
    ).toMatchObject({
      tickMs: 50,
      port: 0,
      compaction: { everyMs: 3_600_000, retainMs: 7 * 24 * 3_600_000 },
    });
  });

  it('FIX-086: a timer setting above the largest timer delay (2^31-1 ms) is refused, not shortened to 1 ms', async () => {
    for (const name of [
      'AGENTROPY_TICK_MS',
      'AGENTROPY_DRAIN_MS',
      'AGENTROPY_COMPACT_EVERY_MS',
    ]) {
      const env = { AGENTROPY_DB: ':memory:', [name]: '3000000000' };
      expect(() => parseHostEnv(env), name).toThrow(
        expect.objectContaining({ code: 'InvalidConfiguration' }),
      );
      await expect(main(env), name).rejects.toMatchObject({
        code: 'InvalidConfiguration',
      });
    }
    expect(
      parseHostEnv({
        AGENTROPY_TICK_MS: '2147483647',
        AGENTROPY_DRAIN_MS: '2147483647',
      }),
    ).toMatchObject({ tickMs: 2_147_483_647, drainMs: 2_147_483_647 });
  });

  it('FEAT-073: a configured schedule calls compact until it is stopped, and a failing run is logged without stopping it', async () => {
    const app = createLocalApp({
      store: new SqliteStore({ path: ':memory:' }),
      pdp: new AllowListPolicy(''),
      profiles: BUILTIN_PROFILES,
    });
    const runs: number[] = [];
    let fail = true;
    const compact = vi
      .spyOn(app, 'compact')
      .mockImplementation(async (retainMs, caller) => {
        runs.push(retainMs);
        expect(caller).toMatchObject({ type: 'service' });
        if (fail) {
          fail = false;
          throw new Error('store down');
        }
        return {} as never;
      });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const stop = startCompaction(app, { everyMs: 5, retainMs: 1_000 }, 't');
      await vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(3));
      expect(new Set(runs)).toEqual(new Set([1_000]));
      const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<
        string,
        unknown
      >;
      expect(line).toMatchObject({ level: 'error', event: 'compaction' });
      expect(JSON.stringify(line)).not.toContain('store down');
      stop();
      const calls = compact.mock.calls.length;
      await new Promise((r) => setTimeout(r, 30));
      expect(compact.mock.calls.length).toBe(calls);
    } finally {
      log.mockRestore();
    }
  });

  it('FEAT-073: the main module is found by path, not by comparing URL strings', () => {
    const at = (...parts: string[]) => resolve(...parts);
    const host = at('app', 'dist', 'host.js');
    expect(isMainModule(pathToFileURL(host).href, host)).toBe(true);
    // The same file named another way: with `..` in the path, and as node reports it.
    expect(
      isMainModule(
        pathToFileURL(host).href,
        at('app', 'dist', '..', 'dist', 'host.js'),
      ),
    ).toBe(true);
    // An encoded URL against the path it stands for (a space is %20 in the URL).
    const spaced = at('app', 'my dir', 'host.js');
    expect(pathToFileURL(spaced).href).toContain('%20');
    expect(isMainModule(pathToFileURL(spaced).href, spaced)).toBe(true);
    expect(
      isMainModule(pathToFileURL(host).href, at('app', 'dist', 'other.js')),
    ).toBe(false);
    expect(isMainModule(pathToFileURL(host).href, undefined)).toBe(false);
    expect(isMainModule('not a url', host)).toBe(false);
  });
});
