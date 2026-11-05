// FEAT-027.2: inbox reconciliation and rebuild (M2-03, R-25), briefing delivery policy with urgent vs deferred
// delivery and a priority resolver with non-downgradable policy floors (M2-04, R-26).
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type InboxEntry,
  type NotifyInput,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  createLocalApp,
  resolveDelivery,
  type InboxPreferences,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const ops: TrustedPrincipal = { id: 'ops', type: 'service', tenantId: 't-1' };

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

function setup(
  opts: {
    preferences?: InboxPreferences;
    push?: (e: InboxEntry) => Promise<boolean>;
  } = {},
) {
  const clock = new FakeClock('2026-11-05T00:00:00.000Z');
  const app = createLocalApp({
    store: sqliteTempStore(),
    pdp: new FakePolicy(),
    now: clock.iso,
    profiles: BUILTIN_PROFILES,
    inbox: {
      ...(opts.preferences ? { preferences: () => opts.preferences! } : {}),
      ...(opts.push ? { push: opts.push } : {}),
    },
  });
  /** Sends the given notifications in order, one step key each. */
  const notifier: Agent<{ items: NotifyInput[] }> = {
    handle: async (inv, ctx) => {
      for (const [i, n] of inv.input.items.entries())
        await ctx.capabilities.invoke('notification', 'notify', n, {
          stepKey: `n${i}`,
        });
      return { kind: 'completed', output: null };
    },
  };
  app.define(def('notifier'), notifier);
  const notify = async (items: NotifyInput[], key: string) => {
    const inst = await app.createInstance(
      {
        definition: { id: 'notifier', version: '1.0.0' },
        ownerId: alice.id,
        idempotencyKey: `inst-${key}`,
      },
      alice,
    );
    await app.delegate(
      {
        target: { instanceId: inst.id },
        input: { items },
        idempotencyKey: key,
        correlationId: key,
      },
      alice,
    );
    await app.runUntilIdle();
  };
  return { app, clock, notify };
}

const n = (severity: NotifyInput['severity'], title: string): NotifyInput => ({
  severity,
  title,
  body: title,
});

describe('briefing delivery policy (M2-04, R-26)', () => {
  it('interrupts come first, then severity; low entries are on-demand and only counted', async () => {
    const { app, notify } = setup();
    await notify(
      [
        n('normal', 'weekly digest'),
        n('low', 'fyi'),
        n('critical', 'card blocked'),
        n('high', 'payment due'),
      ],
      'k',
    );
    const b = await app.inbox.briefing(alice);
    expect(b.entries.map((e) => e.title)).toEqual([
      'card blocked',
      'payment due',
      'weekly digest',
    ]);
    expect(b.onDemand).toBe(1);
    // On-demand entries stay listable and are not marked presented.
    const fyi = (await app.listInbox({}, alice)).entries.find(
      (e) => e.title === 'fyi',
    )!;
    expect(fyi.markers.presentedAt).toBeUndefined();
    expect((await app.inbox.briefing(alice)).entries).toEqual([]);
  });

  it('personal preferences narrow what is mentioned but never hide a policy-floored entry', async () => {
    const { app, notify } = setup({ preferences: { briefFrom: 'critical' } });
    await notify([n('high', 'payment due'), n('normal', 'digest')], 'k');
    expect((await app.inbox.briefing(alice)).entries).toEqual([]);

    // A pending approval has a policy floor of `high`: an agent sending it as `low` or a user muting cannot lower it.
    const entry: InboxEntry = {
      entryId: 'e',
      userId: 'alice',
      tenantId: 't-1',
      source: { eventId: 'x', taskId: 't', type: 'humanActionRequested' },
      agentInstanceId: 'i',
      severity: 'low',
      title: 'Approve?',
      actionRequestId: 'r-1',
      revision: 1,
      markers: {},
    };
    expect(resolveDelivery(entry, { briefFrom: 'critical' })).toEqual({
      severity: 'high',
      delivery: 'mention',
      floored: true,
    });
    expect(
      resolveDelivery(
        { ...entry, markers: { resolvedAt: '2026-11-05T00:00:00.000Z' } },
        { briefFrom: 'critical' },
      ).delivery,
    ).toBe('on-demand');
    expect(resolveDelivery({ ...entry, severity: 'critical' }).delivery).toBe(
      'interrupt',
    );
  });

  it('critical entries are pushed to active clients and marked delivered; push failure leaves durable replay', async () => {
    const pushed: string[] = [];
    let online = true;
    const { app, notify } = setup({
      push: async (e) => {
        if (!online) throw new Error('client gone');
        pushed.push(e.title);
        return true;
      },
    });
    await notify([n('critical', 'fraud alert'), n('high', 'not urgent')], 'a');
    expect(pushed).toEqual(['fraud alert']);
    online = false;
    await notify([n('critical', 'second alert')], 'b');
    const entries = (await app.listInbox({}, alice)).entries;
    const byTitle = new Map(entries.map((e) => [e.title, e]));
    expect(byTitle.get('fraud alert')!.markers.deliveredAt).toBeDefined();
    expect(byTitle.get('second alert')!.markers.deliveredAt).toBeUndefined();
    expect(
      (await app.inbox.briefing(alice)).entries.map((e) => e.title),
    ).toEqual(['fraud alert', 'second alert', 'not urgent']);
  });
});

describe('inbox reconciliation and rebuild (M2-03, R-25)', () => {
  it('recreates missing entries from committed events, keeps existing markers and never touches task state', async () => {
    const { app, notify } = setup();
    await notify([n('high', 'one'), n('high', 'two')], 'k');
    const [one, two] = (await app.listInbox({}, alice)).entries;
    await app.markInbox(one!.entryId, 'read', alice);
    // Simulate a lost projection row.
    await app.store.transaction(async (tx) => {
      const doc = await tx.get('inbox', two!.entryId);
      await tx.remove('inbox', two!.entryId, doc!.revision);
    });
    const tasksBefore = await app.store.transaction((tx) =>
      tx.find('tasks', {}),
    );
    expect(await app.rebuildInbox(ops)).toEqual({ created: 1 });
    expect(await app.rebuildInbox(ops)).toEqual({ created: 0 });
    const after = (await app.listInbox({}, alice)).entries;
    expect(after.map((e) => [e.title, e.revision])).toEqual([
      ['one', 1],
      ['two', 1],
    ]);
    expect(after[0]!.markers.readAt).toBeDefined();
    const tasksAfter = await app.store.transaction((tx) =>
      tx.find('tasks', {}),
    );
    expect(tasksAfter.map((t) => t.revision)).toEqual(
      tasksBefore.map((t) => t.revision),
    );
  });

  it('rebuild is an operator action', async () => {
    const { app } = setup();
    expect(await code(app.rebuildInbox(alice))).toBe('PermissionDenied');
  });
});
