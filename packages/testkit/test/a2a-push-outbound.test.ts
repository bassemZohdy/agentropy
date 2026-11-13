// FEAT-048.3: outbound push configuration at A2A peers (docs/plans/FEAT-048-outbound-push.md). The provider registers a
// webhook at the peer after a delegation; the peer's notification, authenticated by a per-task HMAC token, makes the
// receiver refresh that one projection through the normal GetTask path. The payload is never read.
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A2ACommunicationProvider,
  DefaultCommunicationRouter,
  a2aPushToken,
  createA2APushReceiver,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type A2APushReceiver,
  type RemoteTaskRecord,
} from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy, allowNetwork } from '../src/index.js';
import { liveFetch } from './live-fetch.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const peerIdentity: TrustedPrincipal = {
  id: 'runtime-a',
  type: 'service',
  tenantId: 't-1',
};
const ENDPOINT = 'https://b.example/a2a';
const PUBLIC = 'https://a.example';
const SECRET = 'a-very-long-shared-secret-of-32-bytes-or-more';
const HOUR = 3_600_000;

const summarizer: AgentDefinition = {
  id: 'summarizer',
  version: '1.0.0',
  displayName: 'summarizer',
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

/** Runtime B (the peer, with or without push) and runtime A (with a push-enabled provider and a receiver). */
async function rig(o: { peerPush?: boolean; minIntervalMs?: number } = {}) {
  const wire: string[] = [];
  const configs: { url: string; token: string }[] = [];
  const b = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: new FakeClock('2026-11-11T00:00:00.000Z').iso,
    profiles: BUILTIN_PROFILES,
  });
  b.define(summarizer, {
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
  // Filled in below: the peer's webhook transport is wired straight into A's receiver.
  const wired: { receiver?: A2APushReceiver } = {};
  let refreshes: string[] = [];
  const server = createA2AServer(localAppTarget(b), {
    instanceId: inst.id,
    ...(o.peerPush === false
      ? {}
      : {
          push: {
            allowUrl: (u: URL) => u.origin === PUBLIC,
            retryMs: 1,
            fetch: async (url, init) => {
              const id = decodeURIComponent(
                new URL(url).pathname.replace('/a2a/push/', ''),
              );
              const status = await wired.receiver!.notify(
                id,
                init.headers['x-a2a-notification-token'],
              );
              return { status };
            },
          },
        }),
  });
  const a2a = new A2ACommunicationProvider({
    allowEndpoint: (u: URL) => u.origin === new URL(ENDPOINT).origin,
    credentialRef: 'peer-b',
    credentials: { resolve: async () => ({ token: 'tok-a' }) },
    maxPolls: 0,
    push: { publicUrl: PUBLIC, secret: SECRET },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body) as {
        method: string;
        params?: { url?: string; token?: string };
      };
      wire.push(body.method);
      if (body.method === 'CreateTaskPushNotificationConfig')
        configs.push({ url: body.params!.url!, token: body.params!.token! });
      const res = await server.handle(body, peerIdentity, {
        'a2a-version': init.headers['a2a-version'],
      });
      return { status: res.status, json: async () => res.body };
    },
  });
  const router = new DefaultCommunicationRouter();
  router.register(a2a);
  const a = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: new FakeClock('2026-11-11T00:00:00.000Z').iso,
    profiles: BUILTIN_PROFILES,
    // The poller is an hour away: only a notification can move a projection here.
    communication: { router, sync: { minMs: HOUR, maxMs: HOUR } },
  });
  const receiver = createA2APushReceiver({
    secret: SECRET,
    minIntervalMs: o.minIntervalMs ?? 20,
    refresh: async (id) => {
      refreshes.push(id);
      return a.refreshRemote(id);
    },
  });
  wired.receiver = receiver;
  const delegate = (doc: string, key: string) =>
    a.delegate(
      {
        target: { remote: { endpoint: ENDPOINT, definitionId: 'summarizer' } },
        input: { doc },
        idempotencyKey: key,
        correlationId: key,
      },
      alice,
    );
  const projection = async (taskId: string) =>
    (
      await a.store.transaction((tx) =>
        tx.find<RemoteTaskRecord>('remoteTasks', { where: { taskId } }),
      )
    )[0]!.value;
  return {
    a,
    b,
    server,
    a2a,
    receiver,
    wire,
    configs,
    delegate,
    projection,
    refreshes: () => refreshes,
    resetRefreshes: () => (refreshes = []),
  };
}

describe('outbound push configuration (FEAT-048.3)', () => {
  it('registers a webhook at the peer, and the peer’s notification completes the projection without polling', async () => {
    const r = await rig();
    const h = await r.delegate('memo', 'k1');
    expect(r.wire).toEqual(['SendMessage', 'CreateTaskPushNotificationConfig']);
    expect(r.configs).toHaveLength(1);
    expect(r.configs[0]!.url).toBe(
      `${PUBLIC}/a2a/push/${encodeURIComponent(h.taskId)}`,
    );
    expect(r.configs[0]!.token).toBe(a2aPushToken(SECRET, h.taskId));
    expect((await r.projection(h.taskId)).status).toBe('created');
    await r.b.runUntilIdle(); // the peer does the work and pushes each state to the webhook
    await r.server.pushIdle();
    await r.receiver.idle();
    expect(r.refreshes().every((id) => id === h.taskId)).toBe(true);
    expect(await r.projection(h.taskId)).toMatchObject({
      status: 'completed',
      remoteState: 'TASK_STATE_COMPLETED',
    });
    expect(await r.a.getResult(h.taskId, alice)).toEqual({
      summary: 'summary of memo',
    });
  });

  it('a peer without push support does not fail the delegation: polling stays the fallback', async () => {
    const r = await rig({ peerPush: false });
    const h = await r.delegate('memo', 'k1');
    expect(r.wire).toEqual(['SendMessage', 'CreateTaskPushNotificationConfig']);
    expect((await r.projection(h.taskId)).status).toBe('created');
    await r.b.runUntilIdle();
    expect(await r.a.refreshRemote(h.taskId)).toBe(true); // a manual look still works
    expect((await r.projection(h.taskId)).status).toBe('completed');
  });

  it('is configured explicitly: a plain-http URL, a short secret or a bad URL is refused; the feature flag follows', () => {
    const bad =
      (push: { publicUrl: string; secret: string; allowHttp?: boolean }) =>
      () =>
        new A2ACommunicationProvider({ allowEndpoint: () => false, push });
    expect(bad({ publicUrl: 'http://a.example', secret: SECRET })).toThrow(
      /https/,
    );
    expect(bad({ publicUrl: PUBLIC, secret: 'short' })).toThrow(/32/);
    expect(
      bad({ publicUrl: 'https://u:p@a.example', secret: SECRET }),
    ).toThrow();
    expect(
      bad({ publicUrl: 'https://a.example/x?y=1', secret: SECRET }),
    ).toThrow();
    expect(bad({ publicUrl: 'not a url', secret: SECRET })).toThrow();
    expect(
      new A2ACommunicationProvider({
        allowEndpoint: () => false,
        push: {
          publicUrl: 'http://127.0.0.1:1',
          secret: SECRET,
          allowHttp: true,
        },
      }).features.pushNotifications,
    ).toBe(true);
    expect(
      new A2ACommunicationProvider({ allowEndpoint: () => false }).features
        .pushNotifications,
    ).toBe(false);
  });

  it('tokens are per task and per secret, and url-safe', () => {
    const t1 = a2aPushToken(SECRET, 'a2a:1');
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a2aPushToken(SECRET, 'a2a:1')).toBe(t1);
    expect(a2aPushToken(SECRET, 'a2a:2')).not.toBe(t1);
    expect(a2aPushToken(`${SECRET}x`, 'a2a:1')).not.toBe(t1);
  });

  it('the receiver answers 401 to a missing, wrong or other-task token and refreshes nothing', async () => {
    const r = await rig();
    const h = await r.delegate('memo', 'k1');
    r.resetRefreshes();
    expect(await r.receiver.notify(h.taskId, undefined)).toBe(401);
    expect(await r.receiver.notify(h.taskId, 'nope')).toBe(401);
    expect(
      await r.receiver.notify(h.taskId, a2aPushToken(SECRET, 'a2a:other')),
    ).toBe(401);
    expect(
      await r.receiver.notify('a2a:other', a2aPushToken(SECRET, h.taskId)),
    ).toBe(401);
    await r.receiver.idle();
    expect(r.refreshes()).toEqual([]);
    expect(
      await r.receiver.notify(h.taskId, a2aPushToken(SECRET, h.taskId)),
    ).toBe(202);
    await r.receiver.idle();
    expect(r.refreshes()).toEqual([h.taskId]);
  });

  it('a flood of valid notifications is coalesced into a leading and one trailing refresh per interval', async () => {
    const r = await rig({ minIntervalMs: 40 });
    const h = await r.delegate('memo', 'k1');
    r.resetRefreshes();
    const token = a2aPushToken(SECRET, h.taskId);
    const answers = await Promise.all(
      Array.from({ length: 50 }, () => r.receiver.notify(h.taskId, token)),
    );
    expect(answers.every((s) => s === 202)).toBe(true);
    await r.receiver.idle();
    expect(r.refreshes().length).toBeGreaterThanOrEqual(1);
    expect(r.refreshes().length).toBeLessThanOrEqual(2);
  });

  describe('over HTTP', () => {
    let server: Server | undefined;
    afterEach(() => void server?.close());

    async function http(
      refresh: (id: string) => Promise<unknown>,
      maxBodyBytes = 64,
    ) {
      const receiver = createA2APushReceiver({
        secret: SECRET,
        refresh,
        minIntervalMs: 0,
        maxBodyBytes,
      });
      server = createServer((req, res) => {
        void receiver.handle(req, res).then((served) => {
          if (!served) {
            res.writeHead(404);
            res.end('not ours');
          }
        });
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      allowNetwork([`127.0.0.1:${port}`]);
      const post = (
        path: string,
        token: string | undefined,
        body = '{"statusUpdate":{}}',
        method = 'POST',
      ) =>
        liveFetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            ...(token ? { 'x-a2a-notification-token': token } : {}),
          },
          body,
        });
      return { receiver, post };
    }
    const path = (id: string) => `/a2a/push/${encodeURIComponent(id)}`;

    it('accepts a valid notification with 202 and calls refresh with the decoded task ID, never reading the body', async () => {
      const seen: string[] = [];
      const h = await http(async (id) => void seen.push(id));
      const id = 'a2a:abc/def';
      const ok = await h.post(
        path(id),
        a2aPushToken(SECRET, id),
        'not even json',
      );
      expect(ok.status).toBe(202);
      await h.receiver.idle();
      expect(seen).toEqual([id]);
    });

    it('answers 401 before reading the body, 405 for other methods, 413 for an oversized body, and leaves other paths alone', async () => {
      const seen: string[] = [];
      const h = await http(async (id) => void seen.push(id));
      const id = 'a2a:1';
      const token = a2aPushToken(SECRET, id);
      expect((await h.post(path(id), undefined)).status).toBe(401);
      expect((await h.post(path(id), 'wrong')).status).toBe(401);
      expect((await h.post(path(id), token, '', 'GET')).status).toBe(405);
      expect((await h.post(path(id), token, 'x'.repeat(200))).status).toBe(413);
      expect((await h.post('/elsewhere', token)).status).toBe(404);
      await h.receiver.idle();
      expect(seen).toEqual([]);
    });

    it('a refresh that throws does not fail the notification or crash the receiver', async () => {
      const h = await http(async () => {
        throw new Error('peer exploded');
      });
      const id = 'a2a:1';
      expect((await h.post(path(id), a2aPushToken(SECRET, id))).status).toBe(
        202,
      );
      await h.receiver.idle();
      expect((await h.post(path(id), a2aPushToken(SECRET, id))).status).toBe(
        202,
      );
    });
  });
});
