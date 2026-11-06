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
import { allowNetwork } from '@agentropy/testkit';
import { describe, expect, it, vi } from 'vitest';
import {
  AllowListPolicy,
  a2aEndpoint,
  bearerTokens,
  defineAgents,
  healthHandler,
  schedulerStalled,
  shutdownHost,
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
      pdp: new AllowListPolicy(''),
      profiles: BUILTIN_PROFILES,
    });
    defineAgents(app);
    expect(await a2aEndpoint(app, {})).toBeUndefined();
    const auth = bearerTokens(' s3cret=peer-a, other=peer-b ', 'acme');
    const req = (authorization?: string) =>
      ({ headers: authorization ? { authorization } : {} }) as IncomingMessage;
    expect(await auth(req('Bearer s3cret'))).toEqual({
      id: 'peer-a',
      type: 'service',
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
      pdp: new AllowListPolicy(''),
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
});
