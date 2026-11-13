// FEAT-048.2: refreshing one remote projection on demand (`LocalApp.refreshRemote`), the building block the A2A push
// notification receiver calls (docs/plans/FEAT-048-outbound-push.md). The poller is switched off with a very long
// interval, so only the refresh can move a projection.
import {
  BUILTIN_PROFILES,
  type AgentDefinition,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  A2ACommunicationProvider,
  DefaultCommunicationRouter,
  createA2AServer,
  createLocalApp,
  localAppTarget,
  type RemoteTaskRecord,
} from '../../runtime/src/index.js';
import { sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const peerIdentity: TrustedPrincipal = {
  id: 'runtime-a',
  type: 'service',
  tenantId: 't-1',
};
const ENDPOINT = 'https://b.example/a2a';
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

async function rig() {
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
  const server = createA2AServer(localAppTarget(b), { instanceId: inst.id });
  const wire: string[] = [];
  let down = false;
  const a2a = new A2ACommunicationProvider({
    allowEndpoint: (u: URL) => u.origin === new URL(ENDPOINT).origin,
    credentialRef: 'peer-b',
    credentials: { resolve: async () => ({ token: 'tok-a' }) },
    maxPolls: 0,
    fetch: async (_url, init) => {
      if (down) throw new TypeError('fetch failed');
      wire.push((JSON.parse(init.body) as { method: string }).method);
      const res = await server.handle(JSON.parse(init.body), peerIdentity, {
        'a2a-version': init.headers['a2a-version'],
      });
      // A real peer takes a moment: let concurrent refreshes overlap.
      await new Promise((r) => setTimeout(r, 5));
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
    communication: { router, sync: { minMs: HOUR, maxMs: HOUR } },
  });
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
    wire,
    delegate,
    projection,
    setDown: (v: boolean) => (down = v),
  };
}

describe('refreshing a remote projection on demand (FEAT-048.2)', () => {
  it('asks the peer now and applies the answer, while the slow poller has not', async () => {
    const r = await rig();
    const h = await r.delegate('memo', 'k1');
    await r.a.runUntilIdle(); // the first poll, then the next one is an hour away
    await r.b.runUntilIdle(); // the peer finishes the work
    await r.a.runUntilIdle();
    expect((await r.projection(h.taskId)).status).toBe('created');
    const before = r.wire.filter((m) => m === 'GetTask').length;
    expect(await r.a.refreshRemote(h.taskId)).toBe(true);
    expect(r.wire.filter((m) => m === 'GetTask').length).toBe(before + 1);
    expect(await r.projection(h.taskId)).toMatchObject({
      status: 'completed',
      remoteState: 'TASK_STATE_COMPLETED',
    });
    expect(await r.a.getResult(h.taskId, alice)).toEqual({
      summary: 'summary of memo',
    });
  });

  it('a terminal or unknown projection is left alone and costs no call', async () => {
    const r = await rig();
    const h = await r.delegate('memo', 'k1');
    await r.b.runUntilIdle();
    expect(await r.a.refreshRemote(h.taskId)).toBe(true);
    const calls = r.wire.length;
    expect(await r.a.refreshRemote(h.taskId)).toBe(false); // already completed
    expect(await r.a.refreshRemote('a2a:no-such-task')).toBe(false);
    expect(r.wire.length).toBe(calls);
  });

  it('a refresh that finds nothing new changes nothing and says so', async () => {
    const r = await rig();
    const h = await r.delegate('memo', 'k1'); // the peer has not run it yet
    // The first look records the peer's own state name (the projection starts as "accepted") ...
    expect(await r.a.refreshRemote(h.taskId)).toBe(true);
    const seen = await r.projection(h.taskId);
    expect(seen).toMatchObject({
      status: 'created',
      remoteState: 'TASK_STATE_SUBMITTED',
    });
    // ... and the next one finds nothing new.
    expect(await r.a.refreshRemote(h.taskId)).toBe(false);
    expect((await r.projection(h.taskId)).revision).toBe(seen.revision);
  });

  it('concurrent refreshes of one projection share a single call to the peer', async () => {
    const r = await rig();
    const h = await r.delegate('memo', 'k1');
    await r.b.runUntilIdle();
    const before = r.wire.length;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => r.a.refreshRemote(h.taskId)),
    );
    expect(results.every((x) => x === results[0])).toBe(true);
    expect(r.wire.length - before).toBe(1);
  });

  it('a peer that is down leaves the projection as last observed, records the error and does not throw', async () => {
    const r = await rig();
    const h = await r.delegate('memo', 'k1');
    r.setDown(true);
    expect(await r.a.refreshRemote(h.taskId)).toBe(false);
    expect(await r.projection(h.taskId)).toMatchObject({
      status: 'created',
      lastError: 'RemoteUnavailable',
    });
    r.setDown(false);
    await r.b.runUntilIdle();
    expect(await r.a.refreshRemote(h.taskId)).toBe(true);
    expect((await r.projection(h.taskId)).status).toBe('completed');
  });
});
