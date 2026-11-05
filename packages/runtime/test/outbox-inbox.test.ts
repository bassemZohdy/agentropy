// FEAT-019: TaskEvent outbox, relay (AC-19), envelope validation and replay-safe subscribers (AC-17),
// inbox projection, submitTurn and turn briefing (AC-02).
import {
  isAfter,
  type Agent,
  type AgentMessage,
  type InboxEntry,
  type RouteBinding,
  type TaskEvent,
} from '@agentropy/core';
import { SqliteStore } from '@agentropy/store-sqlite';
import { FakeDirectTarget, FaultInjector } from '@agentropy/testkit';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DirectCommunicationProvider,
  type OutboxRecord,
  type PublishedEvent,
} from '../src/index.js';
import { alice, bob, code, harness, mallory } from './harness.js';

type H = ReturnType<typeof harness>;

const settle = async (h: H) => {
  for (let i = 0; i < 5; i++) {
    await h.wakeups.poll();
    await h.runtime.runUntilIdle();
  }
};

const outbox = (h: H, taskId: string) =>
  h.store
    .transaction((tx) =>
      tx.find<OutboxRecord>('outbox', { where: { aggregateId: taskId } }),
    )
    .then((rows) => rows.map((r) => r.value));

/** Rule-based conversational handler (no reasoning binding): briefing first, delegate on "watch", reply. */
const assistant = (
  monitorInstance: () => string,
): Agent<{ text: string; sessionId: string }> => ({
  handle: async (inv, ctx) => {
    const { entries } = await ctx.capabilities.invoke<
      unknown,
      { entries: InboxEntry[] }
    >('conversation', 'briefing', { sessionId: inv.input.sessionId });
    if (inv.input.text.startsWith('watch')) {
      await ctx.capabilities.invoke(
        'delegation',
        'delegate',
        {
          target: { instanceId: monitorInstance() },
          input: { symbol: 'ACME', below: 100 },
        },
        { stepKey: 'watch:ACME:100' },
      );
    }
    return {
      kind: 'completed',
      output: {
        reply: inv.input.text.startsWith('watch')
          ? 'A monitoring agent is watching ACME for you.'
          : entries.map((e) => e.title).join('; ') || 'Nothing new.',
        briefing: entries.map((e) => ({
          title: e.title,
          revision: e.revision,
        })),
      },
    };
  },
});

const monitor: Agent<{ symbol: string; below: number }> = {
  handle: async (inv, ctx) => {
    let sub = (inv.checkpoint as { sub?: string } | undefined)?.sub;
    if (!sub)
      sub = (
        await ctx.capabilities.invoke<unknown, { subscription: string }>(
          'event-handling',
          'subscribe',
          { source: 'price', filter: { symbol: inv.input.symbol } },
          { stepKey: 'sub' },
        )
      ).subscription;
    const reason = inv.wakeReason;
    const price =
      reason?.kind === 'event'
        ? (reason.payload as { price: number }).price
        : undefined;
    if (price !== undefined && price < inv.input.below) {
      await ctx.capabilities.invoke(
        'notification',
        'notify',
        {
          severity: 'high',
          title: `ACME is at ${price} (below ${inv.input.below})`,
          body: 'Price alert',
        },
        { stepKey: `crossed:${inv.input.below}` },
      );
      return { kind: 'completed', output: { price } };
    }
    return {
      kind: 'waiting',
      wakeup: { anyOf: [{ kind: 'event', subscription: sub }] },
      checkpoint: { sub },
    };
  },
};

function journey(h: H) {
  let monitorId = '';
  h.define(
    'assistant',
    assistant(() => monitorId),
    {
      profile: { id: 'conversational', version: '1.0.0' },
    },
  );
  h.define('monitor', monitor, {
    profile: { id: 'monitoring', version: '1.0.0' },
  });
  return {
    async setup() {
      monitorId = (await h.instance('monitor')).id;
      return (await h.instance('assistant')).id;
    },
  };
}

const reply = async (h: H, taskId: string) =>
  h.tasks.getResult<{
    reply: string;
    briefing: { title: string; revision: number }[];
  }>(taskId, alice);

describe('TaskEvent outbox rows (messaging contract)', () => {
  it('names each transition event, keeps sequence 0 for transitions and numbers progress events after it', async () => {
    const h = harness({ builtin: true });
    h.define('worker', {
      handle: async (_inv, ctx) => {
        await ctx.progress.report({ message: 'half' });
        await ctx.progress.report({ message: 'most' });
        return { kind: 'completed', output: 1 };
      },
    });
    const t = await h.delegate((await h.instance('worker')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    const rows = await outbox(h, t.taskId);
    expect(rows.map((r) => [r.type, r.revision, r.sequence])).toEqual([
      ['taskAccepted', 1, 0],
      ['taskAssigned', 2, 0],
      ['taskStarted', 3, 0],
      ['agentProgressUpdated', 3, 1],
      ['agentProgressUpdated', 3, 2],
      ['taskCompleted', 4, 0],
    ]);
    expect(rows[3]!.data).toEqual({ message: 'half' });
    expect(rows.every((r) => r.published === 1)).toBe(true);
  });

  it('subscribe replays from a (revision, sequence) cursor, drops replays and ends after the terminal event', async () => {
    const h = harness({ builtin: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.define('slow', {
      handle: async () => {
        await gate;
        return { kind: 'completed', output: 1 };
      },
    });
    const t = await h.delegate((await h.instance('slow')).id, {}, 'k');
    const seen: TaskEvent[] = [];
    const reading = (async () => {
      for await (const e of h.stream.subscribe(t.taskId, alice, {
        revision: 1,
        sequence: 0,
      }))
        seen.push(e);
    })();
    await h.runtime.tick();
    release();
    await h.runtime.runUntilIdle();
    await reading;
    expect(seen.map((e) => [e.type, e.revision, e.sequence])).toEqual([
      ['taskAssigned', 2, 0],
      ['taskStarted', 3, 0],
      ['taskCompleted', 4, 0],
    ]);
    expect(
      await code(
        h.stream.subscribe(t.taskId, mallory)[Symbol.asyncIterator]().next(),
      ),
    ).toBe('NotFound');
  });
});

describe('outbox relay (AC-19, R-29)', () => {
  const restartable = () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'agentropy-relay-')),
      'store.db',
    );
    return () => new SqliteStore({ path });
  };

  it('AC-19: crash between transition commit and publish → after restart the relay publishes once and consumers see it once', async () => {
    const open = restartable();
    const faults = new FaultInjector();
    const before = harness({ store: open(), builtin: true, faults });
    before.define('notifier', {
      handle: async (_inv, ctx) => {
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          { severity: 'normal', title: 'Report ready', body: 'See results' },
          { stepKey: 'ready' },
        );
        return { kind: 'completed', output: null };
      },
    });
    const t = await before.delegate(
      (await before.instance('notifier')).id,
      {},
      'k',
    );
    // The process "dies" every time it tries to publish: rows stay committed but unpublished.
    faults.failNext('relay.deliver', 1_000);
    await before.runtime.runUntilIdle();
    expect((await before.tasks.getTask(t.taskId, alice)).status).toBe(
      'completed',
    );
    expect(
      (await outbox(before, t.taskId)).every((r) => r.published === 0),
    ).toBe(true);
    expect((await before.inbox.list({}, alice)).entries).toEqual([]);

    const after = harness({ store: open(), builtin: true });
    const delivered: PublishedEvent[] = [];
    after.relay.register({
      id: 'recorder',
      handle: async (e) => void delivered.push(e),
    });
    expect(await after.relay.drain()).toBe(5);
    expect(await after.relay.drain()).toBe(0);
    expect(delivered.map((e) => e.type)).toEqual([
      'taskAccepted',
      'taskAssigned',
      'taskStarted',
      'notificationCreated',
      'taskCompleted',
    ]);
    expect(new Set(delivered.map((e) => e.eventId)).size).toBe(5);
    const { entries } = await after.inbox.list({}, alice);
    expect(entries.map((e) => e.title)).toEqual(['Report ready']);
  });

  it('crash after delivery but before the published mark re-delivers; the projection stays exactly one entry', async () => {
    const open = restartable();
    const faults = new FaultInjector();
    const before = harness({ store: open(), builtin: true, faults });
    before.define('notifier', {
      handle: async (_inv, ctx) => {
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          { severity: 'normal', title: 'Once', body: 'b' },
          { stepKey: 'once' },
        );
        return { kind: 'completed', output: null };
      },
    });
    const t = await before.delegate(
      (await before.instance('notifier')).id,
      {},
      'k',
    );
    faults.failNext('relay.markPublished', 1_000);
    await before.runtime.runUntilIdle();
    // The first row was delivered to consumers, then the mark "crashed"; the relay stops to keep order.
    expect(
      (await outbox(before, t.taskId)).filter((r) => r.published === 1),
    ).toEqual([]);
    expect((await outbox(before, t.taskId))[0]!.attempts).toBeGreaterThan(0);

    const after = harness({ store: open(), builtin: true });
    await after.relay.drain();
    await after.relay.drain();
    const { entries } = await after.inbox.list({}, alice);
    expect(entries.map((e) => [e.title, e.revision])).toEqual([['Once', 1]]);
    expect(
      (await outbox(after, t.taskId)).every((r) => r.published === 1),
    ).toBe(true);
  });
});

describe('notification.notify journal (platform-internal effect)', () => {
  it('a replayed step returns the original entry and writes one event; a missing step key is rejected', async () => {
    const h = harness({ builtin: true });
    const results: unknown[] = [];
    h.define('twice', {
      handle: async (_inv, ctx) => {
        for (let i = 0; i < 2; i++)
          results.push(
            await ctx.capabilities.invoke(
              'notification',
              'notify',
              { severity: 'low', title: 'x', body: 'y' },
              { stepKey: 'same' },
            ),
          );
        results.push(
          await code(
            ctx.capabilities.invoke('notification', 'notify', {
              severity: 'low',
              title: 'x',
              body: 'y',
            }),
          ),
        );
        results.push(
          await code(
            ctx.capabilities.invoke(
              'notification',
              'notify',
              { severity: 'urgent', title: 'x', body: 'y' },
              { stepKey: 'bad' },
            ),
          ),
        );
        return { kind: 'completed', output: null };
      },
    });
    const t = await h.delegate((await h.instance('twice')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    expect(results[0]).toEqual(results[1]);
    expect(results.slice(2)).toEqual(['SchemaViolation', 'SchemaViolation']);
    expect(
      (await outbox(h, t.taskId)).filter(
        (r) => r.type === 'notificationCreated',
      ),
    ).toHaveLength(1);
    expect((await h.inbox.list({}, alice)).entries).toHaveLength(1);
  });
});

describe('conversation turns and briefing (AC-02, R-36)', () => {
  it('AC-02: the second turn briefs the J1 entry once; the third does not repeat it', async () => {
    const h = harness({ builtin: true });
    const assistantId = await journey(h).setup();
    const turn1 = await h.tasks.submitTurn(
      {
        instanceId: assistantId,
        sessionId: 's',
        text: 'watch ACME below 100',
        idempotencyKey: 't1',
      },
      alice,
    );
    await settle(h);
    expect((await reply(h, turn1.taskId)).reply).toBe(
      'A monitoring agent is watching ACME for you.',
    );
    for (const [i, price] of [120, 105, 99].entries())
      await h.wakeups.publish({
        eventId: `p${i}`,
        source: 'price',
        tenantId: 't-1',
        payload: { symbol: 'ACME', price },
      });
    await settle(h);

    const turn2 = await h.tasks.submitTurn(
      {
        instanceId: assistantId,
        sessionId: 's',
        text: 'anything new?',
        idempotencyKey: 't2',
      },
      alice,
    );
    await settle(h);
    expect((await reply(h, turn2.taskId)).briefing).toEqual([
      { title: 'ACME is at 99 (below 100)', revision: 1 },
    ]);
    expect((await reply(h, turn2.taskId)).reply).toBe(
      'ACME is at 99 (below 100)',
    );

    const turn3 = await h.tasks.submitTurn(
      {
        instanceId: assistantId,
        sessionId: 's',
        text: 'and now?',
        idempotencyKey: 't3',
      },
      alice,
    );
    await settle(h);
    expect((await reply(h, turn3.taskId)).briefing).toEqual([]);
    // The entry stays in the inbox, marked presented at its revision.
    const [entry] = (await h.inbox.list({}, alice)).entries;
    expect(entry!.markers.presentedRevision).toBe(1);
    expect(entry!.userId).toBe('alice');
  });

  it('AC-02: an entry whose revision changes is presented again', async () => {
    const h = harness({ builtin: true });
    const assistantId = await journey(h).setup();
    h.define('reporter', {
      handle: async (inv, ctx) => {
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          {
            severity: 'normal',
            title: `ACME is at ${inv.activation === 1 ? 99 : 95}`,
            body: 'b',
            dedupeKey: 'acme',
          },
          { stepKey: `n${inv.activation}` },
        );
        return inv.activation === 1
          ? {
              kind: 'waiting',
              wakeup: {
                anyOf: [{ kind: 'timer', at: '2026-11-05T00:05:00.000Z' }],
              },
              checkpoint: null,
            }
          : { kind: 'completed', output: null };
      },
    });
    await h.delegate((await h.instance('reporter')).id, {}, 'r');
    await settle(h);
    const turn = (key: string) =>
      h.tasks.submitTurn(
        {
          instanceId: assistantId,
          sessionId: 's',
          text: 'news?',
          idempotencyKey: key,
        },
        alice,
      );
    const a = await turn('a');
    await settle(h);
    expect((await reply(h, a.taskId)).briefing).toEqual([
      { title: 'ACME is at 99', revision: 1 },
    ]);
    h.clock.advanceBy(5 * 60 * 1000);
    await settle(h);
    const b = await turn('b');
    await settle(h);
    expect((await reply(h, b.taskId)).briefing).toEqual([
      { title: 'ACME is at 95', revision: 2 },
    ]);
    const c = await turn('c');
    await settle(h);
    expect((await reply(h, c.taskId)).briefing).toEqual([]);
    expect((await h.inbox.list({}, alice)).entries).toHaveLength(1);
  });

  it('submitTurn is idempotent, owner-only and conversational-only', async () => {
    const h = harness({ builtin: true });
    const assistantId = await journey(h).setup();
    const turn = {
      instanceId: assistantId,
      sessionId: 's',
      text: 'hi',
      idempotencyKey: 'same',
    };
    const first = await h.tasks.submitTurn(turn, alice);
    expect((await h.tasks.submitTurn(turn, alice)).taskId).toBe(first.taskId);
    expect(first.durability).toBe('durable-acceptance');
    expect(await code(h.tasks.submitTurn(turn, bob))).toBe('NotFound');
    expect(await code(h.tasks.submitTurn(turn, mallory))).toBe('NotFound');
    const monitorId = (await h.instance('monitor')).id;
    expect(
      await code(h.tasks.submitTurn({ ...turn, instanceId: monitorId }, alice)),
    ).toBe('UnsupportedOperation');
  });

  it('a turn delegated by someone other than the owner cannot read the owner’s briefing', async () => {
    const h = harness({ builtin: true });
    const assistantId = await journey(h).setup();
    // Unshared, bob cannot even see alice's assistant (D-08); once shared he can delegate, but not read her inbox.
    expect(
      await code(
        h.delegate(assistantId, { sessionId: 's', text: 'hi' }, 'x', bob),
      ),
    ).toBe('NotFound');
    await h.instances.share(assistantId, ['bob'], alice);
    const t = await h.delegate(
      assistantId,
      { sessionId: 's', text: 'hi' },
      'k',
      bob,
    );
    await settle(h);
    expect((await h.tasks.getTask(t.taskId, bob)).outcome?.code).toBe(
      'PermissionDenied',
    );
  });
});

describe('inbox queries and markers', () => {
  it('lists only the caller’s entries with a cursor and hides other users’ entries as NotFound', async () => {
    const h = harness({ builtin: true });
    h.define('notifier', {
      handle: async (_inv, ctx) => {
        for (const n of [1, 2, 3])
          await ctx.capabilities.invoke(
            'notification',
            'notify',
            { severity: 'low', title: `n${n}`, body: 'b' },
            { stepKey: `n${n}` },
          );
        return { kind: 'completed', output: null };
      },
    });
    await h.delegate((await h.instance('notifier')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    const page1 = await h.inbox.list({ limit: 2 }, alice);
    const page2 = await h.inbox.list({ cursor: page1.cursor, limit: 2 }, alice);
    expect([...page1.entries, ...page2.entries].map((e) => e.title)).toEqual([
      'n1',
      'n2',
      'n3',
    ]);
    expect((await h.inbox.list({}, bob)).entries).toEqual([]);
    expect((await h.inbox.list({}, mallory)).entries).toEqual([]);
    const id = page1.entries[0]!.entryId;
    expect(await code(h.inbox.mark(id, 'read', bob))).toBe('NotFound');
    await h.inbox.mark(id, 'read', alice);
    await h.inbox.mark(id, 'acknowledged', alice);
    const marked = (await h.inbox.list({}, alice)).entries[0]!;
    expect(marked.markers.readAt).toBeDefined();
    expect(marked.markers.acknowledgedAt).toBeDefined();
    // Low-severity entries are on-demand by default and acknowledged ones are never briefed.
    expect(await h.inbox.briefing(alice)).toEqual({ entries: [], onDemand: 2 });
  });

  it('a failed child task is projected as one high-severity entry for its owner', async () => {
    const h = harness({ builtin: true });
    h.define(
      'broken',
      {
        handle: async () => {
          throw new Error('boom');
        },
      },
      {
        retryPolicy: {
          maxAttempts: 1,
          backoff: { initialMs: 1, maxMs: 1, multiplier: 1 },
        },
      },
    );
    const brokenId = (await h.instance('broken')).id;
    h.define(
      'parent',
      {
        handle: async (_inv, ctx) => {
          await ctx.capabilities.invoke(
            'delegation',
            'delegate',
            { target: { instanceId: brokenId }, input: {} },
            { stepKey: 'child' },
          );
          return { kind: 'completed', output: null };
        },
      },
      { capabilities: [{ id: 'delegation', versionRange: '^1.0.0' }] },
    );

    await h.delegate((await h.instance('parent')).id, {}, 'p');
    await settle(h);
    const { entries } = await h.inbox.list({}, alice);
    expect(entries.map((e) => [e.title, e.source.type, e.severity])).toEqual([
      ['Task failed', 'taskFailed', 'high'],
    ]);
  });
});

describe('AC-17: envelope validation and replayed (revision, sequence)', () => {
  const envelope: AgentMessage = {
    schemaVersion: 1,
    kind: 'command',
    name: 'ping',
    messageId: 'm-1',
    correlationId: 'c-1',
    idempotencyKey: 'm-1',
    tenantId: 't-1',
    actor: { principalId: 'alice', principalType: 'user' },
    createdAt: '2026-11-05T00:00:00.000Z',
    payload: {},
  };

  it('rejects a malformed envelope, a wrong schemaVersion and a command without an idempotency key at the boundary', async () => {
    const target = new FakeDirectTarget();
    const provider = new DirectCommunicationProvider(
      target,
      'durable-acceptance',
    );
    const route = {} as RouteBinding;
    const ctx = { caller: alice, correlationId: 'c-1' };
    const send = (m: unknown) =>
      code(provider.send(route, m as AgentMessage, ctx));
    const { idempotencyKey: _k, ...noKey } = envelope;
    void _k;
    const { messageId: _m, ...noId } = envelope;
    void _m;
    expect(await send(noId)).toBe('SchemaViolation');
    expect(await send({ ...envelope, kind: 'shout' })).toBe('SchemaViolation');
    expect(await send({ ...envelope, schemaVersion: 2 })).toBe(
      'SchemaViolation',
    );
    expect(await send(noKey)).toBe('SchemaViolation');
    expect(await send({ ...noKey, kind: 'query' })).toBe('no-error');
    expect(await send(envelope)).toBe('no-error');
    expect(target.received).toHaveLength(2);
  });

  it('a subscriber resuming at or past its last (revision, sequence) receives no replayed event', async () => {
    const h = harness({ builtin: true });
    h.define('worker', {
      handle: async (_inv, ctx) => {
        await ctx.progress.report({ message: 'p' });
        return { kind: 'completed', output: 1 };
      },
    });
    const t = await h.delegate((await h.instance('worker')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    const read = async (from?: { revision: number; sequence: number }) => {
      const out: [number, number][] = [];
      for await (const e of h.stream.subscribe(t.taskId, alice, from))
        out.push([e.revision, e.sequence]);
      return out;
    };
    const all = await read();
    expect(all).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 1],
      [4, 0],
    ]);
    expect(await read({ revision: 3, sequence: 0 })).toEqual([
      [3, 1],
      [4, 0],
    ]);
    expect(await read({ revision: 4, sequence: 0 })).toEqual([]);
    expect(
      isAfter({ revision: 3, sequence: 1 }, { revision: 3, sequence: 1 }),
    ).toBe(false);
    expect(
      isAfter({ revision: 4, sequence: 0 }, { revision: 3, sequence: 9 }),
    ).toBe(true);
  });
});
