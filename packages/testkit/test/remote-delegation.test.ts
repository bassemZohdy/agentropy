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
import { describe, expect, it, vi } from 'vitest';
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
async function runtimeB(
  outputOf: (doc: string) => unknown = (doc) => ({
    summary: `summary of ${doc}`,
  }),
) {
  const b = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: new FakeClock('2026-11-06T00:00:00.000Z').iso,
    profiles: BUILTIN_PROFILES,
  });
  b.define(def('summarizer'), {
    handle: async (inv) => ({
      kind: 'completed',
      output: outputOf((inv.input as { doc: string }).doc),
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

function runtimeA(
  server: A2AServer,
  opts: {
    offline?: () => boolean;
    /** While it returns a promise, the peer accepts the connection and never answers (the signal is ignored). */
    hang?: () => Promise<unknown> | undefined;
    clock?: FakeClock;
    sync?: { minMs?: number; maxMs?: number };
    /** Longest a call to the peer may take (FIX-053). */
    timeoutMs?: number;
    /** Which endpoints the A2A provider may call (FIX-054); default: exactly the peer's origin. */
    allowEndpoint?: (url: URL) => boolean;
    allowHttp?: boolean;
    /** Largest output a task may report, local or remote (TASK-068). */
    maxOutputBytes?: number;
    /** Answers instead of the peer, to see what the provider does with it. */
    reply?: () => { status: number } | undefined;
    /** A JSON-RPC error code the peer answers a method with instead of handling it (FIX-080). */
    refuse?: (method: string) => number | undefined;
  } = {},
) {
  const wire: string[] = [];
  const fetched: { url: string; redirect?: string }[] = [];
  const lookups = { credentials: 0 };
  const a2a = new A2ACommunicationProvider({
    credentialRef: 'peer-b',
    credentials: {
      resolve: async () => {
        lookups.credentials++;
        return { token: 'tok-a' };
      },
    },
    maxPolls: 0,
    allowEndpoint:
      opts.allowEndpoint ?? ((u) => u.origin === new URL(ENDPOINT).origin),
    ...(opts.allowHttp ? { allowHttp: true } : {}),
    fetch: async (url, init) => {
      if (opts.offline?.()) throw new TypeError('fetch failed');
      wire.push(init.body);
      fetched.push({
        url,
        ...(init.redirect ? { redirect: init.redirect } : {}),
      });
      const canned = opts.reply?.();
      if (canned) return { status: canned.status, json: async () => ({}) };
      const rpc = JSON.parse(init.body) as { id: string; method: string };
      const refused = opts.refuse?.(rpc.method);
      if (refused !== undefined)
        return {
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: refused, message: 'refused' },
          }),
        };
      const hung = opts.hang?.();
      if (hung) {
        await hung;
        throw new TypeError('fetch failed');
      }
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
    now: (opts.clock ?? new FakeClock('2026-11-06T00:00:00.000Z')).iso,
    profiles: BUILTIN_PROFILES,
    ...(opts.maxOutputBytes
      ? { limits: { maxOutputBytes: opts.maxOutputBytes } }
      : {}),
    // The clock stands still in most tests, so they poll on every pass; the backoff test sets its own.
    communication: {
      router,
      sync: opts.sync ?? { minMs: 0, maxMs: 0 },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
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
  return { a, pdp, audit, wire, fetched, lookups };
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

  it('TASK-068: a remote output over maxOutputBytes fails the projection with SchemaViolation and is not stored', async () => {
    const { b, server } = await runtimeB((doc) => ({
      summary: 'x'.repeat(5_000) + doc,
    }));
    const { a } = runtimeA(server, { maxOutputBytes: 2_048 });
    const parent = await startCoordinator(a);
    await a.runUntilIdle();
    await b.runUntilIdle();
    await a.runUntilIdle();
    const [proj] = await projections(a);
    expect(proj).toMatchObject({
      status: 'failed',
      outcome: { code: 'SchemaViolation' },
    });
    expect(proj!.output).toBeUndefined();
    expect(await code(a.getResult(parent.taskId, alice))).toBe('TaskFailed');
  });

  it('FEAT-070: cancelling the parent cancels its open remote child at the peer on the next sync', async () => {
    const { b, server } = await runtimeB();
    const { a, wire } = runtimeA(server);
    const parent = await startCoordinator(a);
    await a.runUntilIdle();
    expect((await projections(a))[0]).toMatchObject({ status: 'created' });
    await a.cancel(parent.taskId, alice);
    expect((await a.getTask(parent.taskId, alice)).status).toBe('cancelled');
    expect((await projections(a))[0]!.cancelRequestedAt).toBeDefined();
    await a.runUntilIdle(); // the sync asks the peer to cancel instead of for the task's state
    expect((await projections(a))[0]).toMatchObject({ status: 'cancelled' });
    expect(wire.some((w) => w.includes('"CancelTask"'))).toBe(true);
    await b.runUntilIdle();
    const remote = await b.store.transaction((tx) =>
      tx.find<{ status: string }>('tasks', {}),
    );
    expect(remote.map((r) => r.value.status)).toEqual(['cancelled']);
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

describe('remote projection polling backoff (FEAT-039.2)', () => {
  it('a quiet projection is asked less and less often, a due poll finds completion, a terminal one is never asked again', async () => {
    const { b, server } = await runtimeB();
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    const { a, wire } = runtimeA(server, {
      clock,
      sync: { minMs: 1_000, maxMs: 8_000 },
    });
    await a.delegate(
      {
        target: { remote: { endpoint: ENDPOINT, definitionId: 'summarizer' } },
        input: { doc: 'd' },
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      alice,
    );
    const polls = () =>
      wire.filter(
        (w) => (JSON.parse(w) as { method: string }).method === 'GetTask',
      ).length;
    await a.wakeups.poll(); // first poll: due at once; the state changes (accepted -> submitted), pace 1 s
    expect(polls()).toBe(1);
    await a.wakeups.poll();
    await a.wakeups.poll();
    expect(polls()).toBe(1); // not due: the clock has not moved
    clock.advanceBy(1_001);
    await a.wakeups.poll(); // nothing new: quiet = 1 -> wait 2 s
    expect(polls()).toBe(2);
    clock.advanceBy(1_000); // 1 s into the 2 s wait
    await a.wakeups.poll();
    expect(polls()).toBe(2);
    await b.runUntilIdle(); // the remote work finishes meanwhile
    clock.advanceBy(1_001);
    await a.wakeups.poll();
    expect(polls()).toBe(3);
    const [done] = await projections(a);
    expect(done).toMatchObject({ status: 'completed' });
    clock.advanceBy(60_000);
    await a.wakeups.poll();
    expect(polls()).toBe(3); // terminal: never asked again
  });
});

describe('a peer that never answers (FIX-053)', () => {
  const remote = {
    target: { remote: { endpoint: ENDPOINT, definitionId: 'summarizer' } },
    input: { doc: 'd' },
    idempotencyKey: 'k',
    correlationId: 'c',
  };
  /** A local agent on runtime A, to show that dispatch goes on. */
  const local: Agent = {
    handle: async () => ({ kind: 'completed', output: 'local done' }),
  };
  const submitLocal = async (a: ReturnType<typeof runtimeA>['a']) => {
    a.define(def('localworker'), local);
    const inst = await a.createInstance(
      {
        definition: { id: 'localworker', version: '1.0.0' },
        ownerId: alice.id,
        idempotencyKey: 'lw',
      },
      alice,
    );
    return a.delegate(
      {
        target: { instanceId: inst.id },
        input: {},
        idempotencyKey: 'l1',
        correlationId: 'l1',
      },
      alice,
    );
  };

  it('a refresh that hangs costs one timed-out call (RemoteUnavailable); the scheduler tick completes and local tasks are dispatched meanwhile', async () => {
    const { server } = await runtimeB();
    let freeAll!: () => void;
    const hangs = new Promise<void>((r) => (freeAll = r));
    let hanging = false;
    const { a, wire } = runtimeA(server, {
      hang: () => (hanging ? hangs : undefined),
      timeoutMs: 1_000,
    });
    await a.delegate(remote, alice); // accepted while the peer still answers
    const calls = () =>
      wire.filter(
        (w) => (JSON.parse(w) as { method: string }).method === 'GetTask',
      ).length;
    hanging = true;
    const task = await submitLocal(a);
    const stop = a.start(5);
    try {
      // The peer's GetTask is pending (the refresh started), yet the local task is dispatched and completes.
      await vi.waitFor(
        async () => {
          expect(calls()).toBe(1);
          expect((await a.getTask(task.taskId, alice)).status).toBe(
            'completed',
          );
        },
        { timeout: 3_000 },
      );
      expect(await a.getResult(task.taskId, alice)).toBe('local done');
      const [pending] = await projections(a);
      expect(pending?.lastError).toBeUndefined(); // the call has not timed out yet
      expect(a.schedulerStatus().consecutiveFailures).toBe(0);
    } finally {
      freeAll();
    }
    await stop(); // waits for the refresh in flight
    const [after] = await projections(a);
    expect(after).toMatchObject({ lastError: 'RemoteUnavailable' });
    expect(calls()).toBe(1); // one refresh, not one per tick
  });

  it('a call to a peer that ignores the abort signal still ends at the timeout with RemoteUnavailable', async () => {
    const { server } = await runtimeB();
    const never = new Promise<void>(() => undefined);
    let hanging = false;
    const { a } = runtimeA(server, {
      hang: () => (hanging ? never : undefined),
      timeoutMs: 50,
    });
    const h = await a.delegate(remote, alice);
    hanging = true;
    const started = Date.now();
    await a.runUntilIdle(); // refresh the projection: bounded by the timeout
    expect(Date.now() - started).toBeLessThan(2_000);
    const [stale] = await projections(a);
    expect(stale).toMatchObject({
      status: 'created',
      lastError: 'RemoteUnavailable',
    });
    // Delegating and cancelling are bounded the same way, and say why.
    await expect(
      a.delegate({ ...remote, idempotencyKey: 'k2' }, alice),
    ).rejects.toMatchObject({
      code: 'RemoteUnavailable',
      details: { reason: 'timeout' },
    });
    await expect(a.cancel(h.taskId, alice)).rejects.toMatchObject({
      code: 'RemoteUnavailable',
    });
  });
});

describe('the endpoints the A2A provider may call (FIX-054)', () => {
  /** An agent that delegates to whatever endpoint its input names: the agent supplies the endpoint. */
  const prober = (calls: { n: number }): Agent<{ endpoint: string }> => ({
    handle: async (inv, ctx) => {
      calls.n++;
      await ctx.capabilities.invoke(
        'delegation',
        'delegate',
        {
          target: {
            remote: {
              endpoint: inv.input.endpoint,
              definitionId: 'summarizer',
            },
          },
          input: { doc: 'secret' },
        },
        { stepKey: 'probe' },
      );
      return { kind: 'completed', output: 'sent' };
    },
  });
  const remote = (endpoint: string, key = 'k') => ({
    target: { remote: { endpoint, definitionId: 'summarizer' } },
    input: { doc: 'd' },
    idempotencyKey: key,
    correlationId: key,
  });
  const nothingLeft = (r: ReturnType<typeof runtimeA>) => {
    expect(r.wire).toEqual([]); // no request was made
    expect(r.fetched).toEqual([]);
    expect(r.lookups.credentials).toBe(0); // and the credential was never looked up
  };

  it('an endpoint an agent names that the list does not admit is PermissionDenied: no request, no credential lookup, no retry', async () => {
    const { server } = await runtimeB();
    const r = runtimeA(server);
    const calls = { n: 0 };
    r.a.define(
      def('prober', {
        capabilities: [{ id: 'delegation', versionRange: '^1.0.0' }],
      }),
      prober(calls),
    );
    const inst = await r.a.createInstance(
      {
        definition: { id: 'prober', version: '1.0.0' },
        ownerId: alice.id,
        idempotencyKey: 'p',
      },
      alice,
    );
    const handle = await r.a.delegate(
      {
        target: { instanceId: inst.id },
        input: { endpoint: 'https://evil.example/a2a' },
        idempotencyKey: 'probe',
        correlationId: 'probe',
      },
      alice,
    );
    await r.a.runUntilIdle();
    const task = await r.a.getTask(handle.taskId, alice);
    expect(task.status).toBe('failed');
    expect(task.outcome?.code).toBe('PermissionDenied'); // not retried as a transport failure
    expect(calls.n).toBe(1);
    nothingLeft(r);
    // The agent-supplied address is not echoed into the error.
    expect(JSON.stringify(task.outcome)).not.toContain('evil.example');
  });

  it('http is refused even when the list admits it, unless the provider allows http', async () => {
    const { server } = await runtimeB();
    const strict = runtimeA(server, { allowEndpoint: () => true });
    await expect(
      strict.a.delegate(remote('http://b.example/a2a'), alice),
    ).rejects.toMatchObject({
      code: 'PermissionDenied',
      details: { reason: 'endpoint' },
    });
    nothingLeft(strict);
    const lax = runtimeA(server, {
      allowEndpoint: (u) => u.origin === 'http://b.example',
      allowHttp: true,
    });
    await lax.a.delegate(remote('http://b.example/a2a'), alice);
    expect(lax.fetched[0]?.url).toBe('http://b.example/a2a');
  });

  it('refuses credentials in the URL, an address that is not a URL, and a predicate that throws', async () => {
    const { server } = await runtimeB();
    const r = runtimeA(server, { allowEndpoint: () => true });
    for (const endpoint of [
      'https://user:pw@b.example/a2a',
      'https://:pw@b.example/a2a',
      'not a url',
    ])
      await expect(
        r.a.delegate(remote(endpoint, endpoint), alice),
      ).rejects.toMatchObject({ code: 'PermissionDenied' });
    const throwing = runtimeA(server, {
      allowEndpoint: () => {
        throw new Error('list unavailable');
      },
    });
    await expect(
      throwing.a.delegate(remote(ENDPOINT), alice),
    ).rejects.toMatchObject({ code: 'PermissionDenied' }); // fails closed
    nothingLeft(r);
    nothingLeft(throwing);
  });

  it('an admitted endpoint works, is fetched without following redirects, and a redirect answer is RemoteUnavailable', async () => {
    const { server } = await runtimeB();
    const r = runtimeA(server);
    await r.a.delegate(remote(ENDPOINT), alice);
    expect(r.fetched[0]).toEqual({ url: ENDPOINT, redirect: 'manual' });
    expect(r.lookups.credentials).toBeGreaterThan(0);
    let redirect = false;
    const moved = runtimeA(server, {
      reply: () => (redirect ? { status: 302 } : undefined),
    });
    redirect = true;
    await expect(
      moved.a.delegate(remote(ENDPOINT, 'k2'), alice),
    ).rejects.toMatchObject({ code: 'RemoteUnavailable' });
  });

  it('the provider cannot be built without a list', () => {
    for (const bad of [undefined, 'https://b.example', {}])
      expect(
        () =>
          new A2ACommunicationProvider({
            allowEndpoint: bad,
          } as never),
      ).toThrowError(expect.objectContaining({ code: 'InvalidConfiguration' }));
    expect(() => new A2ACommunicationProvider()).toThrowError(
      expect.objectContaining({ code: 'InvalidConfiguration' }),
    );
  });
});

describe('a cancel the peer refuses settles the projection (FIX-080)', () => {
  const calls = (wire: string[], method: string) =>
    wire.filter((w) => (JSON.parse(w) as { method: string }).method === method)
      .length;

  it('FIX-080: a remote child that finished before the parent was cancelled is settled from GetTask after the peer refuses the cancel (InvalidState)', async () => {
    const { b, server } = await runtimeB();
    const { a, wire } = runtimeA(server);
    const parent = await startCoordinator(a);
    await a.runUntilIdle();
    await b.runUntilIdle(); // the remote task completes at the peer; A has not looked since
    await a.cancel(parent.taskId, alice);
    expect((await projections(a))[0]!.cancelRequestedAt).toBeDefined();
    await a.runUntilIdle(); // CancelTask is refused (TaskNotCancelable), GetTask in the same poll
    const [settled] = await projections(a);
    expect(settled).toMatchObject({
      status: 'completed',
      remoteState: 'TASK_STATE_COMPLETED',
    });
    expect(settled!.lastError).toBeUndefined();
    expect(calls(wire, 'CancelTask')).toBe(1);
    const asked = calls(wire, 'GetTask');
    for (let i = 0; i < 3; i++) await a.runUntilIdle();
    expect(calls(wire, 'CancelTask')).toBe(1); // terminal: the peer is not asked again
    expect(calls(wire, 'GetTask')).toBe(asked);
    expect((await a.getTask(parent.taskId, alice)).status).toBe('cancelled');
  });

  it('FIX-080: a peer that no longer knows the task (NotFound) fails the projection with NotFound, on CancelTask or on the GetTask after a refusal', async () => {
    for (const refuse of [
      (m: string) => (m === 'CancelTask' ? -32001 : undefined),
      (m: string) =>
        m === 'CancelTask' ? -32002 : m === 'GetTask' ? -32001 : undefined,
    ]) {
      const { server } = await runtimeB();
      let refusing = false;
      const { a, wire } = runtimeA(server, {
        refuse: (m) => (refusing ? refuse(m) : undefined),
      });
      const parent = await startCoordinator(a);
      await a.runUntilIdle();
      refusing = true;
      await a.cancel(parent.taskId, alice);
      await a.runUntilIdle();
      const [gone] = await projections(a);
      expect(gone).toMatchObject({
        status: 'failed',
        outcome: { code: 'NotFound' },
      });
      const sent = wire.length;
      await a.runUntilIdle();
      expect(wire.length).toBe(sent);
    }
  });

  it('FIX-080: a peer that cannot cancel (UnsupportedOperation) is followed by GetTask until the remote task ends', async () => {
    const { b, server } = await runtimeB();
    let refusing = false;
    const { a, wire } = runtimeA(server, {
      refuse: (m) => (refusing && m === 'CancelTask' ? -32004 : undefined),
    });
    const parent = await startCoordinator(a);
    await a.runUntilIdle();
    refusing = true;
    await a.cancel(parent.taskId, alice);
    await a.runUntilIdle();
    const [open] = await projections(a);
    expect(open).toMatchObject({ status: 'created' }); // still running at the peer
    expect(open!.cancelRequestedAt).toBeDefined();
    expect(open!.lastError).toBeUndefined();
    await b.runUntilIdle(); // the peer finishes it anyway
    await a.runUntilIdle();
    expect((await projections(a))[0]).toMatchObject({ status: 'completed' });
    const sent = wire.length;
    await a.runUntilIdle();
    expect(wire.length).toBe(sent);
  });

  it('FIX-080: an unreachable peer still leaves a cancel-requested projection as last observed; the cancel goes through when it returns', async () => {
    const { b, server } = await runtimeB();
    let offline = false;
    const { a } = runtimeA(server, { offline: () => offline });
    const parent = await startCoordinator(a);
    await a.runUntilIdle();
    offline = true;
    await a.cancel(parent.taskId, alice);
    await a.runUntilIdle();
    expect((await projections(a))[0]).toMatchObject({
      status: 'created',
      lastError: 'RemoteUnavailable',
    });
    offline = false;
    await a.runUntilIdle();
    expect((await projections(a))[0]).toMatchObject({ status: 'cancelled' });
    await b.runUntilIdle();
    const remote = await b.store.transaction((tx) =>
      tx.find<{ status: string }>('tasks', {}),
    );
    expect(remote.map((r) => r.value.status)).toEqual(['cancelled']);
  });
});
