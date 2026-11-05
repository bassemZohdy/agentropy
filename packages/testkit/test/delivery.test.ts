// FEAT-027.3: delivery and recovery (M2-02, M2-06) — relay leader lease across processes, provider outage with
// retries on the same idempotency key, delayed callbacks through the out-of-process activation ingress with
// deduplication, and ingress envelope/identity rules.
import {
  BUILTIN_PROFILES,
  AgentropyError,
  type Agent,
  type AgentDefinition,
  type AgentMessage,
  type TrustedPrincipal,
} from '@agentropy/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CALLBACK_SOURCE,
  OutboxRelay,
  createActivationIngress,
  createLocalApp,
  type OutboxRecord,
  type PublishedEvent,
} from '../../runtime/src/index.js';
import {
  SqliteStore,
  alice,
  harness,
  mallory,
} from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy, FaultInjector } from '../src/index.js';

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

const envelope = (over: Partial<AgentMessage>): AgentMessage => ({
  schemaVersion: 1,
  kind: 'command',
  name: 'agent.delegate',
  messageId: 'm-1',
  correlationId: 'c-1',
  idempotencyKey: 'm-1',
  tenantId: 't-1',
  actor: { principalId: 'alice', principalType: 'user' },
  createdAt: '2026-11-05T00:00:00.000Z',
  payload: {},
  ...over,
});

describe('relay leader lease (M2-06)', () => {
  it('only the lease holder delivers; after the holder crashes its lease expires and another relay replays in order', async () => {
    const h = harness();
    h.define('job', {
      handle: async () => ({ kind: 'completed', output: 1 }),
    });
    const t = await h.delegate((await h.instance('job')).id, {}, 'k');
    // Stop the harness's own relay from draining: deliver only through the two relays below.
    const pending = await h.store.transaction((tx) =>
      tx.find<OutboxRecord>('outbox', { where: { published: 0 } }),
    );
    expect(pending.length).toBeGreaterThan(0);

    const seenA: PublishedEvent[] = [];
    const seenB: PublishedEvent[] = [];
    const faults = new FaultInjector();
    const relay = (id: string, sink: PublishedEvent[], f?: FaultInjector) =>
      new OutboxRelay({
        store: h.store,
        relayId: id,
        leaseMs: 1_000,
        now: h.clock.iso,
        consumers: [{ id: 'sink', handle: async (e) => void sink.push(e) }],
        ...(f ? { faults: f } : {}),
      });
    const a = relay('relay-a', seenA, faults);
    const b = relay('relay-b', seenB);
    faults.failNext('relay.markPublished');
    expect(await a.drain()).toBe(0); // "crashed" after delivering the first row
    expect(await b.drain()).toBe(0); // A still holds the lease
    h.clock.advanceBy(1_500);
    const delivered = await b.drain();
    expect(delivered).toBe(pending.length);
    expect(seenB.map((e) => [e.taskId, e.revision, e.sequence])).toEqual(
      pending
        .map((r) => r.value)
        .map((r) => [t.taskId, r.revision, r.sequence]),
    );
    // A's first delivery is replayed by B (at-least-once); consumers deduplicate by eventId.
    expect(seenA.map((e) => e.eventId)).toEqual([seenB[0]!.eventId]);
    expect(await a.drain()).toBe(0); // B now holds the lease
  });
});

describe('provider outage (M2-06)', () => {
  it('a retryable outage is retried with backoff on the same idempotency key until the provider recovers', async () => {
    const h = harness();
    let down = 2;
    const original = h.cap.invoke.bind(h.cap);
    h.cap.invoke = async <I, O>(
      op: string,
      input: I,
      ctx: { idempotencyKey?: string },
    ): Promise<O> => {
      if (down-- > 0) {
        h.cap.calls.push({
          operation: op,
          input,
          ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
        });
        throw new AgentropyError('ProviderUnavailable', 'provider down');
      }
      return original<I, O>(op, input, ctx);
    };
    h.define('caller', {
      handle: async (_inv, ctx) => {
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          { severity: 'low', title: 't', body: 'b' },
          { stepKey: 'send' },
        );
        return { kind: 'completed', output: 'sent' };
      },
    });
    const t = await h.delegate((await h.instance('caller')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    expect((await h.tasks.getTask(t.taskId, alice)).status).toBe('assigned');
    for (let i = 0; i < 4; i++) {
      h.clock.advanceBy(10_000);
      await h.runtime.runUntilIdle();
    }
    expect(await h.tasks.getResult(t.taskId, alice)).toBe('sent');
    const keys = new Set(h.cap.calls.map((c) => c.idempotencyKey));
    expect(h.cap.calls).toHaveLength(3);
    expect(keys.size).toBe(1);
  });
});

describe('delayed callbacks through the activation ingress (M2-02)', () => {
  const setup = (path: string) => {
    const clock = new FakeClock('2026-11-05T00:00:00.000Z');
    const pdp = new FakePolicy();
    const app = createLocalApp({
      store: new SqliteStore({ path }),
      pdp,
      now: clock.iso,
      profiles: BUILTIN_PROFILES,
    });
    /** Starts an out-of-band job (callback ID = task ID) and waits for its callback. */
    const waiter: Agent = {
      handle: async (inv, ctx) => {
        if (inv.wakeReason?.kind === 'event')
          return {
            kind: 'completed',
            output: (inv.wakeReason.payload as { data: unknown }).data,
          };
        const { subscription } = await ctx.capabilities.invoke<
          unknown,
          { subscription: string }
        >(
          'event-handling',
          'subscribe',
          { source: CALLBACK_SOURCE, filter: { callbackId: inv.taskId } },
          { stepKey: 'callback' },
        );
        return {
          kind: 'waiting',
          wakeup: { anyOf: [{ kind: 'event', subscription }] },
          checkpoint: null,
        };
      },
    };
    app.define(
      def('waiter', { profile: { id: 'monitoring', version: '1.0.0' } }),
      waiter,
    );
    return { app, clock, pdp, ingress: createActivationIngress(app) };
  };

  it('a callback redelivered before and after a restart wakes the task exactly once', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentropy-cb-')), 's.db');
    const first = setup(path);
    const inst = await first.app.createInstance(
      {
        definition: { id: 'waiter', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'w',
      },
      alice,
    );
    const accepted = await first.ingress.receive(
      envelope({
        messageId: 'start-1',
        idempotencyKey: 'start-1',
        payload: { target: { instanceId: inst.id }, input: {} },
      }),
      alice,
    );
    expect(accepted).toMatchObject({ status: 'accepted' });
    const taskId = (accepted as { taskId: string }).taskId;
    // Redelivery of the same activation message returns the same task.
    expect(
      await first.ingress.receive(
        envelope({
          messageId: 'start-1-retry',
          idempotencyKey: 'start-1',
          payload: { target: { instanceId: inst.id }, input: {} },
        }),
        alice,
      ),
    ).toMatchObject({ status: 'accepted', taskId });
    await first.app.runUntilIdle();
    expect((await first.app.getTask(taskId, alice)).status).toBe('waiting');

    const callback = envelope({
      kind: 'event',
      name: 'agent.callback',
      messageId: 'cb-1',
      idempotencyKey: undefined,
      payload: { callbackId: taskId, data: { approved: true } },
    });
    const service: TrustedPrincipal = {
      id: 'billing-webhook',
      type: 'service',
      tenantId: 't-1',
    };
    expect(await first.ingress.receive(callback, service)).toEqual({
      status: 'recorded',
      eventId: 'cb-1',
    });
    expect(await first.ingress.receive(callback, service)).toEqual({
      status: 'duplicate',
      eventId: 'cb-1',
    });

    const second = setup(path); // restart
    expect(await second.ingress.receive(callback, service)).toEqual({
      status: 'duplicate',
      eventId: 'cb-1',
    });
    await second.app.runUntilIdle();
    expect(await second.app.getResult(taskId, alice)).toEqual({
      approved: true,
    });
    const activations = await second.app.store.transaction((tx) =>
      tx.find('executions', { where: { taskId } }),
    );
    expect(activations).toHaveLength(2);
  });

  it('identity comes from the transport, not the envelope; bad envelopes and unknown names are rejected with public errors', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentropy-ing-')), 's.db');
    const { app, pdp, ingress } = setup(path);
    const inst = await app.createInstance(
      {
        definition: { id: 'waiter', version: '1.0.0' },
        ownerId: 'alice',
        idempotencyKey: 'w',
      },
      alice,
    );
    const forged = await ingress.receive(
      envelope({
        tenantId: 't-1',
        actor: { principalId: 'alice', principalType: 'user' },
        payload: { target: { instanceId: inst.id }, input: {} },
      }),
      mallory,
    );
    expect(forged).toMatchObject({
      status: 'rejected',
      error: { code: 'TenantMismatch' },
    });
    expect(
      await ingress.receive(envelope({ schemaVersion: 2 }), alice),
    ).toMatchObject({ status: 'rejected', error: { code: 'SchemaViolation' } });
    expect(
      await ingress.receive(envelope({ idempotencyKey: undefined }), alice),
    ).toMatchObject({ status: 'rejected', error: { code: 'SchemaViolation' } });
    expect(
      await ingress.receive(envelope({ name: 'agent.reboot' }), alice),
    ).toMatchObject({
      status: 'rejected',
      error: { code: 'UnsupportedOperation' },
    });
    expect(
      await ingress.receive(
        envelope({}),
        undefined as unknown as TrustedPrincipal,
      ),
    ).toMatchObject({ status: 'rejected', error: { code: 'Unauthenticated' } });
    pdp.denied.add('event:publish');
    expect(
      await ingress.receive(
        envelope({
          kind: 'event',
          name: 'agent.event',
          idempotencyKey: undefined,
          payload: { source: 'price', data: { p: 1 } },
        }),
        alice,
      ),
    ).toMatchObject({
      status: 'rejected',
      error: { code: 'PermissionDenied' },
    });
  });
});
