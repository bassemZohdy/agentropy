// FEAT-027.9: remote targets in delegation.delegate — TaskService-side routing through the CommunicationRouter, a
// local projection kept in sync with the authoritative remote task, and a parent woken when the remote child ends.
// Runtime A delegates to an agent on runtime B over A2A 1.0 (fake fetch into B's A2A server) and over the custom
// broker provider sample.
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
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
  DefaultCommunicationRouter,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type A2AServer,
  type RemoteTaskRecord,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeAudit, FakeClock, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const carol: TrustedPrincipal = { id: 'carol', type: 'user', tenantId: 't-1' };
const peerIdentity: TrustedPrincipal = {
  id: 'runtime-a',
  type: 'service',
  tenantId: 't-1',
};
const ENDPOINT = 'https://b.example/a2a';

const def = (
  id: string,
  over: Partial<AgentDefinition> = {},
): AgentDefinition => ({
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
  ...over,
});

/** Runtime B: bob's summarizer, exposed over A2A. */
async function runtimeB() {
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
  return {
    b,
    instanceId: inst.id,
    server: createA2AServer(localAppTarget(b), { instanceId: inst.id }),
  };
}

function runtimeA(server: A2AServer, opts: { offline?: () => boolean } = {}) {
  const wire: string[] = [];
  const a2a = new A2ACommunicationProvider({
    credentialRef: 'peer-b',
    credentials: { resolve: async () => ({ token: 'tok-a' }) },
    maxPolls: 0,
    fetch: async (_url, init) => {
      if (opts.offline?.()) throw new TypeError('fetch failed');
      wire.push(init.body);
      const principal =
        init.headers.authorization === 'Bearer tok-a'
          ? peerIdentity
          : undefined;
      const res = await server.handle(JSON.parse(init.body), principal, {
        'a2a-version': init.headers['a2a-version'],
      });
      return { status: res.status, json: async () => res.body };
    },
  });
  const router = new DefaultCommunicationRouter();
  router.register(a2a);
  const pdp = new FakePolicy();
  const audit = new FakeAudit();
  const a = createLocalApp({
    store: sqliteTempStore(),
    pdp,
    audit,
    now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
    profiles: BUILTIN_PROFILES,
    communication: { router },
  });
  /** Delegates to the remote summarizer and completes with its result. */
  const coordinator: Agent<{ doc: string }> = {
    handle: async (inv, ctx) => {
      if (inv.wakeReason?.kind === 'child-tasks') {
        const [child] = inv.wakeReason.children;
        return child!.status === 'completed'
          ? { kind: 'completed', output: { remote: child!.output } }
          : {
              kind: 'failed',
              code: 'TaskFailed',
              message: 'remote child failed',
              retryable: false,
            };
      }
      const handle = await ctx.capabilities.invoke<unknown, { taskId: string }>(
        'delegation',
        'delegate',
        {
          target: {
            remote: {
              endpoint: ENDPOINT,
              definitionId: 'summarizer',
              version: '1.0.0',
            },
          },
          input: { doc: inv.input.doc },
        },
        { stepKey: 'summarize' },
      );
      return {
        kind: 'waiting',
        wakeup: {
          anyOf: [
            { kind: 'child-tasks', taskIds: [handle.taskId], mode: 'all' },
          ],
        },
        checkpoint: { child: handle.taskId },
      };
    },
  };
  a.define(
    def('coordinator', {
      capabilities: [{ id: 'delegation', versionRange: '^1.0.0' }],
    }),
    coordinator,
  );
  return { a, pdp, audit, wire };
}

async function startCoordinator(
  a: ReturnType<typeof runtimeA>['a'],
  caller = alice,
  key = 'k',
) {
  const inst = await a.createInstance(
    {
      definition: { id: 'coordinator', version: '1.0.0' },
      ownerId: caller.id,
      idempotencyKey: `c-${key}`,
    },
    caller,
  );
  return a.delegate(
    {
      target: { instanceId: inst.id },
      input: { doc: 'q3-report' },
      idempotencyKey: key,
      correlationId: key,
    },
    caller,
  );
}

const projections = (a: ReturnType<typeof runtimeA>['a']) =>
  a.store
    .transaction((tx) => tx.find<RemoteTaskRecord>('remoteTasks', {}))
    .then((r) => r.map((d) => d.value));

describe('remote delegation through the router (FEAT-027.9)', () => {
  it('an agent delegates to a remote agent; the projection follows the remote task and wakes the parent with its result', async () => {
    const { b, server } = await runtimeB();
    const { a, audit } = runtimeA(server);
    const parent = await startCoordinator(a);
    await a.runUntilIdle();
    expect((await a.getTask(parent.taskId, alice)).status).toBe('waiting');
    const [proj] = await projections(a);
    expect(proj).toMatchObject({
      status: 'created',
      remoteState: 'TASK_STATE_SUBMITTED',
      parentTaskId: parent.taskId,
    });
    expect((await a.getTask(proj!.taskId, alice)).authority).toBe('remote');

    await b.runUntilIdle(); // the remote side does the work
    await a.runUntilIdle(); // sync sees completion, the parent wakes
    expect(await a.getResult(parent.taskId, alice)).toEqual({
      remote: { summary: 'summary of q3-report' },
    });
    const [done] = await projections(a);
    expect(done).toMatchObject({
      status: 'completed',
      remoteState: 'TASK_STATE_COMPLETED',
    });
    expect(audit.events.map((e) => e.type)).toContain('task.delegate.remote');
  });

  it('the application can delegate remotely too; the projection is visible only to its delegator', async () => {
    const { b, server } = await runtimeB();
    const { a } = runtimeA(server);
    const h = await a.delegate(
      {
        target: { remote: { endpoint: ENDPOINT, definitionId: 'summarizer' } },
        input: { doc: 'memo' },
        idempotencyKey: 'direct-1',
        correlationId: 'direct-1',
      },
      alice,
    );
    expect(h.durability).toBe('none');
    expect(await code(a.getResult(h.taskId, alice))).toBe('NotReady');
    expect(await code(a.getTask(h.taskId, carol))).toBe('NotFound');
    await b.runUntilIdle();
    await a.runUntilIdle();
    expect(await a.getResult(h.taskId, alice)).toEqual({
      summary: 'summary of memo',
    });
  });

  it('is idempotent per key (same remote task, no second remote call) and conflicts on a different payload', async () => {
    const { server } = await runtimeB();
    const { a, wire } = runtimeA(server);
    const req = (doc: string) => ({
      target: { remote: { endpoint: ENDPOINT, definitionId: 'summarizer' } },
      input: { doc },
      idempotencyKey: 'same',
      correlationId: 'c',
    });
    const first = await a.delegate(req('x'), alice);
    const sends = wire.filter((w) => w.includes('SendMessage')).length;
    expect((await a.delegate(req('x'), alice)).taskId).toBe(first.taskId);
    expect(wire.filter((w) => w.includes('SendMessage')).length).toBe(sends);
    expect(await code(a.delegate(req('y'), alice))).toBe('IdempotencyConflict');
  });

  it('local policy decides before anything leaves the process, and no grant reference crosses the wire', async () => {
    const { server } = await runtimeB();
    const { a, pdp, wire } = runtimeA(server);
    pdp.denied.add('delegation:delegate');
    expect(
      await code(
        a.delegate(
          {
            target: {
              remote: { endpoint: ENDPOINT, definitionId: 'summarizer' },
            },
            input: {},
            idempotencyKey: 'denied',
            correlationId: 'c',
          },
          alice,
        ),
      ),
    ).toBe('PermissionDenied');
    expect(wire).toEqual([]);
    pdp.denied.clear();
    await a.delegate(
      {
        target: { remote: { endpoint: ENDPOINT, definitionId: 'summarizer' } },
        input: {},
        idempotencyKey: 'ok',
        correlationId: 'c',
      },
      { ...alice, delegatedAuthorityRef: 'grant-local-only' },
    );
    expect(wire.join('')).not.toContain('grant-local-only');
  });

  it('an unreachable peer leaves the projection as last observed; it catches up when the peer returns', async () => {
    const { b, server } = await runtimeB();
    let offline = false;
    const { a } = runtimeA(server, { offline: () => offline });
    const h = await a.delegate(
      {
        target: { remote: { endpoint: ENDPOINT, definitionId: 'summarizer' } },
        input: { doc: 'd' },
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
    );
    await b.runUntilIdle();
    offline = true;
    await a.runUntilIdle();
    const [stale] = await projections(a);
    expect(stale).toMatchObject({
      status: 'created',
      lastError: 'RemoteUnavailable',
    });
    offline = false;
    await a.runUntilIdle();
    expect(await a.getResult(h.taskId, alice)).toEqual({
      summary: 'summary of d',
    });
  });

  it('cancel reaches the remote task; a terminal remote task cannot be cancelled again', async () => {
    const { b, server } = await runtimeB();
    const { a } = runtimeA(server);
    const h = await a.delegate(
      {
        target: { remote: { endpoint: ENDPOINT, definitionId: 'summarizer' } },
        input: { doc: 'd' },
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
    );
    expect((await a.cancel(h.taskId, alice)).status).toBe('cancelled');
    const remoteTasks = await b.listTasks({}, peerIdentity);
    expect(remoteTasks.tasks.map((t) => t.status)).toEqual(['cancelled']);
    expect(await code(a.cancel(h.taskId, alice))).toBe('InvalidState');
  });

  it('works the same through the custom broker provider; without a router remote targets fail NoCompatibleRoute', async () => {
    const { b, instanceId } = await runtimeB();
    const broker = new InMemoryBroker();
    serveOnBroker(broker, 'agents.t-1.summarizer', localAppTarget(b), {
      instanceId,
    });
    const router = new DefaultCommunicationRouter();
    router.register(
      new BrokerCommunicationProvider(
        broker,
        (t) => `agents.${t.tenantId}.${t.definitionId}`,
      ),
    );
    const a = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
      communication: { router },
    });
    const h = await a.delegate(
      {
        target: {
          remote: { endpoint: 'broker:agents', definitionId: 'summarizer' },
        },
        input: { doc: 'via broker' },
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      peerIdentity,
    );
    await b.runUntilIdle();
    await a.runUntilIdle();
    expect(await a.getResult(h.taskId, peerIdentity)).toEqual({
      summary: 'summary of via broker',
    });

    const plain = createLocalApp({
      store: sqliteTempStore(),
      pdp: new FakePolicy(),
      profiles: BUILTIN_PROFILES,
    });
    expect(
      await code(
        plain.delegate(
          {
            target: {
              remote: { endpoint: ENDPOINT, definitionId: 'summarizer' },
            },
            input: {},
            idempotencyKey: 'k',
            correlationId: 'c',
          },
          alice,
        ),
      ),
    ).toBe('NoCompatibleRoute');
  });
});
