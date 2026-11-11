// FEAT-044.1: paging of A2A 1.0 `ListTaskPushNotificationConfigs` (`pageSize`, `pageToken`, `nextPageToken`). The list
// is ordered by config ID, the cursor is opaque, pages are bounded (1-100, default 50), and every page is still scoped to
// the creating principal and re-checks that the caller can see the task.
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type A2AServer,
} from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const a: TrustedPrincipal = { id: 'svc-a', type: 'service', tenantId: 't-1' };
const b: TrustedPrincipal = { id: 'svc-b', type: 'service', tenantId: 't-1' };
const HOOK = 'https://hooks.a.example/a2a';

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

const rpc = (
  server: A2AServer,
  method: string,
  params: Record<string, unknown>,
  who: TrustedPrincipal = a,
) => server.handle({ jsonrpc: '2.0', id: 9, method, params }, who);

async function peer() {
  const app = createLocalApp({
    store: sqliteTempStore(),
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
  const server = createA2AServer(localAppTarget(app), {
    instanceId: inst.id,
    push: {
      allowUrl: (u) => u.origin === 'https://hooks.a.example',
      fetch: async () => ({ status: 200 }),
      maxConfigsPerTask: 200,
    },
  });
  const sent = await server.handle(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: {
          role: 'ROLE_USER',
          messageId: 'm-1',
          contextId: 'ctx-1',
          parts: [{ text: '{"doc":"x"}', mediaType: 'application/json' }],
        },
      },
    },
    a,
  );
  const taskId = (sent.body.result as { task: { id: string } }).task.id;
  const create = async (ids: string[], who: TrustedPrincipal = a) => {
    for (const id of ids)
      await rpc(
        server,
        'CreateTaskPushNotificationConfig',
        { taskId, id, url: HOOK },
        who,
      );
  };
  const list = async (
    params: Record<string, unknown> = {},
    who: TrustedPrincipal = a,
  ) => {
    const r = await rpc(
      server,
      'ListTaskPushNotificationConfigs',
      { taskId, ...params },
      who,
    );
    return {
      error: r.body.error as { code: number } | undefined,
      configs: (
        (r.body.result as { configs?: { id: string }[] })?.configs ?? []
      ).map((c) => c.id),
      next: (r.body.result as { nextPageToken?: string })?.nextPageToken,
    };
  };
  return { server, taskId, create, list };
}

describe('A2A push-config paging (FEAT-044.1)', () => {
  it('pages the configs in ID order and ends with an empty nextPageToken', async () => {
    const p = await peer();
    await p.create(['c3', 'c1', 'c5', 'c2', 'c4']); // created out of order, listed by ID
    const one = await p.list({ pageSize: 2 });
    expect(one.configs).toEqual(['c1', 'c2']);
    expect(one.next).toBeTruthy();
    const two = await p.list({ pageSize: 2, pageToken: one.next });
    expect(two.configs).toEqual(['c3', 'c4']);
    expect(two.next).toBeTruthy();
    const three = await p.list({ pageSize: 2, pageToken: two.next });
    expect(three.configs).toEqual(['c5']);
    expect(three.next).toBe('');
  });

  it('without a page size one page carries everything up to the default, with no token', async () => {
    const p = await peer();
    await p.create(['c1', 'c2', 'c3']);
    const all = await p.list();
    expect(all.configs).toEqual(['c1', 'c2', 'c3']);
    expect(all.next).toBe('');
  });

  it('the default page is 50 configs and the maximum 100', async () => {
    const p = await peer();
    await p.create(
      Array.from({ length: 120 }, (_, i) => `c${String(i).padStart(3, '0')}`),
    );
    const def50 = await p.list();
    expect(def50.configs).toHaveLength(50);
    expect(def50.next).toBeTruthy();
    expect((await p.list({ pageSize: 100 })).configs).toHaveLength(100);
    expect((await p.list({ pageSize: 101 })).error?.code).toBe(-32602);
  });

  it('rejects a page size that is not 1 to 100 and a page token it did not issue', async () => {
    const p = await peer();
    await p.create(['c1']);
    for (const pageSize of [0, -1, 1.5, '2', null])
      expect((await p.list({ pageSize })).error?.code).toBe(-32602);
    for (const pageToken of ['not-a-token', 42, 'e30'])
      expect((await p.list({ pageToken })).error?.code).toBe(-32602);
  });

  it('the cursor survives a config deleted or added between pages: nothing repeats, nothing after the cursor is lost', async () => {
    const p = await peer();
    await p.create(['c2', 'c4', 'c6', 'c8']);
    const one = await p.list({ pageSize: 2 });
    expect(one.configs).toEqual(['c2', 'c4']);
    await rpc(p.server, 'DeleteTaskPushNotificationConfig', {
      taskId: p.taskId,
      id: 'c4',
    });
    await p.create(['c1', 'c5']); // c1 sorts before the cursor, c5 after it
    const two = await p.list({ pageSize: 2, pageToken: one.next });
    expect(two.configs).toEqual(['c5', 'c6']);
    expect(
      (await p.list({ pageSize: 2, pageToken: two.next })).configs,
    ).toEqual(['c8']);
  });

  it('every page stays scoped to the creating principal: a token from one principal reveals none of its configs to another', async () => {
    const p = await peer();
    await p.create(['c1', 'c2', 'c3']);
    await p.create(['b1', 'z1'], b);
    const mine = await p.list({ pageSize: 2 });
    expect(mine.configs).toEqual(['c1', 'c2']);
    // b presents a's token (the cursor sits after c2): it gets its own z1 and never a's c3.
    const theirs = await p.list({ pageSize: 2, pageToken: mine.next }, b);
    expect(theirs.configs).toEqual(['z1']);
    expect(theirs.next).toBe('');
    expect((await p.list({}, b)).configs).toEqual(['b1', 'z1']);
    expect(
      (await p.list({ pageSize: 2, pageToken: mine.next })).configs,
    ).toEqual(['c3']);
  });
});
