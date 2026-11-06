// FEAT-028.8: container host — health and readiness answers, default-deny sample policy, no error details on the
// unauthenticated port. The handler is called directly (the suite runs without sockets).
import { BUILTIN_PROFILES, type TrustedPrincipal } from '@agentropy/core';
import { createLocalApp } from '@agentropy/runtime';
import { SqliteStore } from '@agentropy/store-sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { AllowListPolicy, defineAgents, healthHandler } from '../src/host.js';

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
});
