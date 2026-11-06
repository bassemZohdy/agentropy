// FEAT-029.2: A2A 1.0 push notifications. The four TaskPushNotificationConfig methods, webhook delivery of
// StreamResponse updates, the SSRF guard (allow-list, https, no embedded credentials, no redirects), header
// injection, principal scoping, write-only credentials, retries and quotas.
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  a2aAgentCard,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type A2APushFetch,
  type A2APushOptions,
  type A2AServer,
} from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakeDirectTarget, FakePolicy } from '../src/index.js';

const caller: TrustedPrincipal = {
  id: 'svc-a',
  type: 'service',
  tenantId: 't-1',
};
const HOOK = 'https://hooks.a.example/a2a';

interface Delivery {
  url: string;
  init: Parameters<A2APushFetch>[1];
}

/** Webhook stand-in answering with the given statuses in turn (then 200). */
function webhook(statuses: number[] = []) {
  const deliveries: Delivery[] = [];
  const fetch: A2APushFetch = async (url, init) => {
    deliveries.push({ url, init });
    return { status: statuses.shift() ?? 200 };
  };
  return { fetch, deliveries };
}

const allowHook = (u: URL) => u.origin === 'https://hooks.a.example';

const def: AgentDefinition = {
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

async function appPeer(push: Partial<A2APushOptions> = {}) {
  const b = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
    profiles: BUILTIN_PROFILES,
  });
  b.define(def, {
    handle: async () => ({ kind: 'completed', output: { summary: 'ok' } }),
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
  const hook = webhook();
  const errors: unknown[] = [];
  const server = createA2AServer(localAppTarget(b), {
    instanceId: inst.id,
    push: {
      allowUrl: allowHook,
      fetch: hook.fetch,
      retryMs: 1,
      onDeliveryError: (e) => errors.push(e),
      ...push,
    },
  });
  const taskId = await send(server, 'm-1');
  return { b, server, hook, errors, taskId };
}

async function send(server: A2AServer, messageId: string): Promise<string> {
  const r = await server.handle(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: {
          role: 'ROLE_USER',
          messageId,
          contextId: 'ctx-1',
          parts: [{ text: '{"doc":"x"}', mediaType: 'application/json' }],
        },
      },
    },
    caller,
  );
  return (r.body.result as { task: { id: string } }).task.id;
}

const rpc = (
  server: A2AServer,
  method: string,
  params: Record<string, unknown>,
  who: TrustedPrincipal = caller,
) => server.handle({ jsonrpc: '2.0', id: 9, method, params }, who);

const kinds = (ds: Delivery[]) =>
  ds.map((d) => {
    const b = JSON.parse(d.init.body) as Record<
      string,
      { status?: { state: string } }
    >;
    return b['statusUpdate']
      ? `status:${b['statusUpdate'].status!.state}`
      : Object.keys(b)[0]!;
  });

describe('A2A push notifications', () => {
  it('delivers every update after the config to the webhook, with token, credentials and no redirects', async () => {
    const p = await appPeer();
    const created = await rpc(p.server, 'CreateTaskPushNotificationConfig', {
      taskId: p.taskId,
      id: 'cfg-1',
      url: HOOK,
      token: 'tok-123',
      authentication: { scheme: 'Bearer', credentials: 'hook-secret' },
    });
    // Credentials are write-only.
    expect(created.body.result).toEqual({
      id: 'cfg-1',
      taskId: p.taskId,
      url: HOOK,
      token: 'tok-123',
      authentication: { scheme: 'Bearer' },
    });
    await p.b.runUntilIdle();
    await p.server.pushIdle();
    expect(kinds(p.hook.deliveries)).toEqual([
      'status:TASK_STATE_WORKING',
      'artifactUpdate',
      'status:TASK_STATE_COMPLETED',
    ]);
    const first = p.hook.deliveries[0]!;
    expect(first.url).toBe(HOOK);
    expect(first.init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        'x-a2a-notification-token': 'tok-123',
        authorization: 'Bearer hook-secret',
      },
    });
    expect(JSON.parse(first.init.body)).toMatchObject({
      statusUpdate: { taskId: p.taskId, contextId: p.taskId },
    });
    expect(p.errors).toEqual([]);
  });

  it('Get, List and Delete are scoped to the creating principal; deleting stops deliveries', async () => {
    const p = await appPeer();
    await rpc(p.server, 'CreateTaskPushNotificationConfig', {
      taskId: p.taskId,
      id: 'cfg-1',
      url: HOOK,
      authentication: { scheme: 'Basic', credentials: 'c2VjcmV0' },
    });
    const got = await rpc(p.server, 'GetTaskPushNotificationConfig', {
      taskId: p.taskId,
      id: 'cfg-1',
    });
    expect(JSON.stringify(got.body)).not.toContain('c2VjcmV0');
    expect(
      (
        (
          await rpc(p.server, 'ListTaskPushNotificationConfigs', {
            taskId: p.taskId,
          })
        ).body.result as { configs: { id: string }[] }
      ).configs.map((c) => c.id),
    ).toEqual(['cfg-1']);
    expect(
      (
        await rpc(p.server, 'DeleteTaskPushNotificationConfig', {
          taskId: p.taskId,
          id: 'cfg-1',
        })
      ).body.result,
    ).toEqual({});
    expect(
      (
        await rpc(p.server, 'GetTaskPushNotificationConfig', {
          taskId: p.taskId,
          id: 'cfg-1',
        })
      ).body.error?.code,
    ).toBe(-32001);
    expect(
      (
        await rpc(p.server, 'DeleteTaskPushNotificationConfig', {
          taskId: p.taskId,
          id: 'cfg-1',
        })
      ).body.error?.code,
    ).toBe(-32001);
    await p.b.runUntilIdle();
    await p.server.pushIdle();
    expect(p.hook.deliveries).toEqual([]);
  });

  it('another principal of the tenant sees none of the configs; another tenant does not see the task', async () => {
    const fake = new FakeDirectTarget();
    const server = createA2AServer(fake, {
      push: { allowUrl: allowHook, fetch: webhook().fetch },
    });
    const taskId = await send(server, 'm-1');
    await rpc(server, 'CreateTaskPushNotificationConfig', {
      taskId,
      id: 'cfg-1',
      url: HOOK,
    });
    const peer: TrustedPrincipal = { ...caller, id: 'svc-other' };
    expect(
      (
        await rpc(
          server,
          'GetTaskPushNotificationConfig',
          { taskId, id: 'cfg-1' },
          peer,
        )
      ).body.error?.code,
    ).toBe(-32001);
    expect(
      (await rpc(server, 'ListTaskPushNotificationConfigs', { taskId }, peer))
        .body.result,
    ).toEqual({ configs: [], nextPageToken: '' });
    expect(
      (
        await rpc(
          server,
          'DeleteTaskPushNotificationConfig',
          { taskId, id: 'cfg-1' },
          peer,
        )
      ).body.error?.code,
    ).toBe(-32001);
    expect(
      (
        await rpc(
          server,
          'ListTaskPushNotificationConfigs',
          { taskId },
          { ...caller, tenantId: 't-2' },
        )
      ).body.error?.code,
    ).toBe(-32001);
  });

  it('SSRF and injection guard: allow-list, https only, no userinfo, no CR/LF in token or credentials', async () => {
    const fake = new FakeDirectTarget();
    const server = createA2AServer(fake, {
      push: { allowUrl: allowHook, fetch: webhook().fetch },
    });
    const taskId = await send(server, 'm-1');
    const create = async (extra: Record<string, unknown>) =>
      (
        await rpc(server, 'CreateTaskPushNotificationConfig', {
          taskId,
          url: HOOK,
          ...extra,
        })
      ).body.error?.data as { code: string } | undefined;
    expect(
      (await create({ url: 'https://169.254.169.254/latest' }))?.code,
    ).toBe('PermissionDenied');
    expect((await create({ url: 'http://hooks.a.example/a2a' }))?.code).toBe(
      'PermissionDenied',
    );
    expect(
      (await create({ url: 'https://u:p@hooks.a.example/a2a' }))?.code,
    ).toBe('PermissionDenied');
    expect((await create({ url: 'file:///etc/passwd' }))?.code).toBe(
      'PermissionDenied',
    );
    expect((await create({ url: 'not a url' }))?.code).toBe('SchemaViolation');
    expect((await create({ url: undefined }))?.code).toBe('SchemaViolation');
    expect((await create({ token: 'a\r\nX-Evil: 1' }))?.code).toBe(
      'SchemaViolation',
    );
    expect(
      (
        await create({
          authentication: { scheme: 'Bearer x', credentials: 'c' },
        })
      )?.code,
    ).toBe('SchemaViolation');
    expect(
      (
        await create({
          authentication: { scheme: 'Bearer', credentials: 'c\nX: y' },
        })
      )?.code,
    ).toBe('SchemaViolation');
    expect(await create({ id: 'ok' })).toBeUndefined();
    const httpServer = createA2AServer(fake, {
      push: { allowUrl: () => true, allowHttp: true, fetch: webhook().fetch },
    });
    expect(
      (
        await rpc(httpServer, 'CreateTaskPushNotificationConfig', {
          taskId,
          url: 'http://localhost:8080/hook',
        })
      ).body.error,
    ).toBeUndefined();
  });

  it('retries 5xx and 429 with backoff, gives up on other 4xx at once, and reports undelivered notifications', async () => {
    const p = await appPeer({ maxAttempts: 3 });
    const statuses = [503, 429, 200, 400];
    p.hook.deliveries.length = 0;
    const hook = webhook(statuses);
    const errors: unknown[] = [];
    const server = createA2AServer(localAppTarget(p.b), {
      push: {
        allowUrl: allowHook,
        fetch: hook.fetch,
        retryMs: 1,
        maxAttempts: 3,
        onDeliveryError: (e) => errors.push(e),
      },
    });
    await rpc(server, 'CreateTaskPushNotificationConfig', {
      taskId: p.taskId,
      id: 'cfg-r',
      url: HOOK,
    });
    await p.b.runUntilIdle();
    await server.pushIdle();
    // WORKING: 503, 429, 200 (three attempts). The artifact: 400, not retried. COMPLETED: 200.
    expect(kinds(hook.deliveries)).toEqual([
      'status:TASK_STATE_WORKING',
      'status:TASK_STATE_WORKING',
      'status:TASK_STATE_WORKING',
      'artifactUpdate',
      'status:TASK_STATE_COMPLETED',
    ]);
    expect(errors).toEqual([
      { taskId: p.taskId, configId: 'cfg-r', status: 400 },
    ]);
  });

  it('quota per task, replacement by ID, terminal tasks and servers without push', async () => {
    const p = await appPeer({ maxConfigsPerTask: 1 });
    const create = (id: string, url = HOOK) =>
      rpc(p.server, 'CreateTaskPushNotificationConfig', {
        taskId: p.taskId,
        id,
        url,
      });
    expect((await create('a')).body.error).toBeUndefined();
    expect(
      (await create('a', 'https://hooks.a.example/v2')).body.result,
    ).toMatchObject({ id: 'a', url: 'https://hooks.a.example/v2' });
    expect(
      ((await create('b')).body.error?.data as { code: string }).code,
    ).toBe('QuotaExceeded');
    await p.b.runUntilIdle();
    await p.server.pushIdle();
    expect(new Set(p.hook.deliveries.map((d) => d.url))).toEqual(
      new Set(['https://hooks.a.example/v2']),
    );
    expect((await create('c')).body.error?.code).toBe(-32004);
    const plain = createA2AServer(new FakeDirectTarget());
    const t = await send(plain, 'm-1');
    expect(
      (
        await rpc(plain, 'CreateTaskPushNotificationConfig', {
          taskId: t,
          url: HOOK,
        })
      ).body.error?.code,
    ).toBe(-32003);
  });

  it('the AgentCard advertises push notifications only when asked', () => {
    expect(
      a2aAgentCard({
        name: 'S',
        description: 'd',
        version: '1.0.0',
        url: 'https://b.example/a2a',
        pushNotifications: true,
      })['capabilities'],
    ).toEqual({ streaming: false, pushNotifications: true });
  });
});

describe('A2A push notifications, durable (FEAT-034.3)', () => {
  /** Reversible stand-in for a KMS-backed sealer. */
  const sealer = {
    seal: async (s: string) => `sealed:${Buffer.from(s).toString('base64')}`,
    open: async (s: string) =>
      Buffer.from(s.replace(/^sealed:/, ''), 'base64').toString(),
  };

  /** A server process on a shared store: its own LocalApp and webhook. */
  async function serverOn(
    store: ReturnType<typeof sqliteTempStore>,
    push: Partial<A2APushOptions> = {},
  ) {
    const app = createLocalApp({
      store,
      pdp: new FakePolicy(),
      now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
      profiles: BUILTIN_PROFILES,
    });
    app.define(def, {
      handle: async () => ({ kind: 'completed', output: { summary: 'ok' } }),
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
    const hook = webhook();
    const server = createA2AServer(localAppTarget(app), {
      instanceId: inst.id,
      push: {
        allowUrl: allowHook,
        fetch: hook.fetch,
        retryMs: 1,
        store,
        sealer,
        ...push,
      },
    });
    return { app, server, hook };
  }

  it('configs survive a restart: secrets are stored sealed, delivery resumes on another server', async () => {
    const store = sqliteTempStore();
    // Server 1 accepts the task and the config, then stops (its runtime never runs again).
    const one = await serverOn(store);
    const taskId = await send(one.server, 'm-1');
    await rpc(one.server, 'CreateTaskPushNotificationConfig', {
      taskId,
      id: 'cfg-1',
      url: HOOK,
      token: 'tok-123',
      authentication: { scheme: 'Basic', credentials: 'c2VjcmV0' },
    });
    const stored = JSON.stringify(
      await store.transaction((tx) => tx.find('pushConfigs', {})),
    );
    expect(stored).not.toContain('tok-123');
    expect(stored).not.toContain('c2VjcmV0');
    expect(stored).toContain('sealed:');

    const two = await serverOn(store);
    expect(await two.server.resumePush()).toBe(1);
    expect(await two.server.resumePush()).toBe(0); // already watching
    await two.app.runUntilIdle();
    await two.server.pushIdle();
    expect(kinds(two.hook.deliveries).at(-1)).toBe(
      'status:TASK_STATE_COMPLETED',
    );
    const headers = two.hook.deliveries[0]!.init.headers;
    expect(headers['x-a2a-notification-token']).toBe('tok-123');
    expect(headers.authorization).toBe('Basic c2VjcmV0');
    // Config methods on the new server see the stored config; reads still hide credentials.
    const got = await rpc(two.server, 'GetTaskPushNotificationConfig', {
      taskId,
      id: 'cfg-1',
    });
    expect(got.body.result).toMatchObject({
      id: 'cfg-1',
      authentication: { scheme: 'Basic' },
    });
    expect(JSON.stringify(got.body)).not.toContain('c2VjcmV0');
    // Its last delivered state is terminal: a later start resumes nothing.
    const three = await serverOn(store);
    expect(await three.server.resumePush()).toBe(0);
  });

  it('a webhook that missed updates while no server watched gets the current state on resume', async () => {
    const store = sqliteTempStore();
    const one = await serverOn(store);
    const taskId = await send(one.server, 'm-1');
    await rpc(one.server, 'CreateTaskPushNotificationConfig', {
      taskId,
      id: 'cfg-1',
      url: HOOK,
    });
    // The task completes while no push server is running.
    const worker = await serverOn(store);
    await worker.app.runUntilIdle();
    const later = await serverOn(store);
    expect(await later.server.resumePush()).toBe(1);
    await later.server.pushIdle();
    expect(kinds(later.hook.deliveries)).toEqual(['task']);
    const body = JSON.parse(later.hook.deliveries[0]!.init.body) as {
      task: { status: { state: string } };
    };
    expect(body.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('without a sealer, configs with secrets are refused; configs without secrets are stored', async () => {
    const store = sqliteTempStore();
    const s = await serverOn(store, { sealer: undefined });
    const taskId = await send(s.server, 'm-1');
    const refused = await rpc(s.server, 'CreateTaskPushNotificationConfig', {
      taskId,
      url: HOOK,
      token: 'tok-123',
    });
    expect(refused.body.error?.data).toMatchObject({
      code: 'UnsupportedOperation',
    });
    const ok = await rpc(s.server, 'CreateTaskPushNotificationConfig', {
      taskId,
      id: 'plain',
      url: HOOK,
    });
    expect(ok.body.result).toMatchObject({ id: 'plain' });
    expect(
      await store.transaction((tx) => tx.find('pushConfigs', {})),
    ).toHaveLength(1);
  });

  it('deleting a config ends its watcher at once, before the task moves again', async () => {
    const p = await appPeer();
    await rpc(p.server, 'CreateTaskPushNotificationConfig', {
      taskId: p.taskId,
      id: 'cfg-1',
      url: HOOK,
    });
    await rpc(p.server, 'DeleteTaskPushNotificationConfig', {
      taskId: p.taskId,
      id: 'cfg-1',
    });
    const idle = await Promise.race([
      p.server.pushIdle().then(() => 'idle'),
      new Promise((r) => setTimeout(() => r('still watching'), 500)),
    ]);
    expect(idle).toBe('idle');
  });
});
