// FEAT-022.3: effect journal acceptance — AC-07 (R-34). Internal effects commit with their journal entry and
// replay once; an external provider that honors the derived key returns the original effect; a provider that
// cannot honor keys is only usable by a tool that explicitly declares at-least-once semantics.
import type {
  Agent,
  ToolDescriptor,
  ToolInvocationContext,
  TrustedPrincipal,
} from '@agentropy/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DefaultToolExecutor,
  DirectToolProvider,
  InMemoryToolRegistry,
  ToolProviderRegistry,
  type OutboxRecord,
} from '../../runtime/src/index.js';
import {
  SqliteStore,
  alice,
  code,
  harness,
} from '../../runtime/test/harness.js';
import { FakeAudit, FakePolicy } from '../src/index.js';

type H = ReturnType<typeof harness>;
const SECOND = 1000;

describe('AC-07: crash after an internal effect commits, before the task disposition', () => {
  it('replay after restart yields one inbox entry and one notificationCreated event', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentropy-ac07-')), 's.db');
    let crashed = false;
    const notifier: Agent = {
      handle: async (_inv, ctx) => {
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          { severity: 'high', title: 'Payout sent', body: 'b' },
          { stepKey: 'notify-payout' },
        );
        if (!crashed) {
          crashed = true;
          // The worker dies here: the effect and its journal entry are committed, the disposition never is.
          return new Promise(() => {});
        }
        return { kind: 'completed', output: 'done' };
      },
    };
    const before = harness({ builtin: true, store: new SqliteStore({ path }) });
    before.define('notifier', notifier);
    const t = await before.delegate(
      (await before.instance('notifier')).id,
      {},
      'k',
    );
    await before.runtime.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect((await before.tasks.getTask(t.taskId, alice)).status).toBe(
      'running',
    );

    const after = harness({ builtin: true, store: new SqliteStore({ path }) });
    after.define('notifier', notifier);
    after.clock.advanceBy(5 * SECOND); // past the dead worker's lease
    for (let i = 0; i < 3; i++) await after.runtime.runUntilIdle();
    expect(await after.tasks.getResult(t.taskId, alice)).toBe('done');
    const notifications = (
      await after.store.transaction((tx) =>
        tx.find<OutboxRecord>('outbox', { where: { aggregateId: t.taskId } }),
      )
    ).filter((r) => r.value.type === 'notificationCreated');
    expect(notifications).toHaveLength(1);
    expect(
      (await after.inbox.list({}, alice)).entries.map((e) => e.title),
    ).toEqual(['Payout sent']);
    const journal = await after.store.transaction((tx) =>
      tx.find('effects', { where: { taskId: t.taskId } }),
    );
    expect(journal).toHaveLength(1);
  });

  it('a retried attempt passes the same derived idempotency key to an external provider', async () => {
    const h: H = harness();
    let attempt = 0;
    h.define('caller', {
      handle: async (_inv, ctx) => {
        await ctx.capabilities.invoke(
          'notification',
          'notify',
          { severity: 'low', title: 't', body: 'b' },
          { stepKey: 'external-step' },
        );
        attempt++;
        if (attempt === 1) throw new Error('worker blew up after the call');
        return { kind: 'completed', output: null };
      },
    });
    const t = await h.delegate((await h.instance('caller')).id, {}, 'k');
    await h.runtime.runUntilIdle();
    h.clock.advanceBy(2 * SECOND);
    await h.runtime.runUntilIdle();
    expect((await h.tasks.getTask(t.taskId, alice)).status).toBe('completed');
    const keys = h.cap.calls.map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('AC-07: external providers and declared semantics', () => {
  const admin: TrustedPrincipal = {
    id: 'admin',
    type: 'user',
    tenantId: 't-1',
  };
  const agent: TrustedPrincipal = {
    id: 'inst',
    type: 'agent',
    tenantId: 't-1',
  };
  const tool = (
    idempotency: ToolDescriptor['idempotency'],
  ): ToolDescriptor => ({
    id: `pay.${idempotency}`,
    version: '1.0.0',
    description: 'Pay',
    inputSchema: true,
    effect: 'external',
    idempotency,
    permission: `tool:pay.${idempotency}:call`,
  });

  function setup() {
    const security = {
      pdp: new FakePolicy(),
      audit: new FakeAudit(),
      now: () => '2026-11-05T00:00:00.000Z',
    };
    const registry = new InMemoryToolRegistry(security, () => true);
    const ledger = new Map<string, string>();
    let effects = 0;
    const keyed = new DirectToolProvider({
      pay: (_i: unknown, ctx: ToolInvocationContext) => {
        const key = ctx.idempotencyKey!;
        if (!ledger.has(key)) ledger.set(key, `pay-${++effects}`);
        return { paymentId: ledger.get(key) };
      },
    });
    // A provider that ignores keys: every call is a new effect.
    const plain = new (class extends DirectToolProvider {
      override readonly id = 'plain';
      override readonly features = {
        ...keyed.features,
        idempotencyKeys: false,
      };
    })({ pay: () => ({ paymentId: `pay-${++effects}` }) });
    const providers = new ToolProviderRegistry();
    providers.register(keyed);
    providers.register(plain);
    const executor = new DefaultToolExecutor({
      ...security,
      registry,
      providers,
    });
    const activate = async (d: ToolDescriptor, providerId: string) => {
      const rec = await registry.register(
        d,
        [
          {
            bindingId: providerId,
            toolId: d.id,
            toolVersion: d.version,
            providerId,
            providerVersion: '1.0.0',
            config: { function: 'pay' },
            default: true,
          },
        ],
        { publisher: 'acme', source: 'test' },
        admin,
      );
      await registry.activate({ id: d.id, version: d.version }, admin);
      return {
        toolId: d.id,
        toolVersion: d.version,
        bindingId: providerId,
        providerId,
        providerVersion: '1.0.0',
        digest: rec.provenance.digest,
      };
    };
    const ctx = (executionId: string) => ({
      tenantId: 't-1',
      taskId: 'task-1',
      executionId,
      principal: agent,
      signal: new AbortController().signal,
      stepKey: 'payout',
    });
    return { executor, activate, ctx, effects: () => effects };
  }

  it('a provider honoring the key returns the original effect on replay', async () => {
    const s = setup();
    const pin = await s.activate(tool('keyed'), 'direct');
    const first = await s.executor.invoke(pin, {}, s.ctx('e-1'));
    const replay = await s.executor.invoke(pin, {}, s.ctx('e-2'));
    expect(replay).toEqual(first);
    expect(s.effects()).toBe(1);
  });

  it('a key-ignoring provider is refused for a keyed tool and allowed only as declared at-least-once', async () => {
    const s = setup();
    const keyedOnPlain = await s.activate(tool('keyed'), 'plain');
    expect(await code(s.executor.invoke(keyedOnPlain, {}, s.ctx('e-1')))).toBe(
      'InvalidConfiguration',
    );
    expect(s.effects()).toBe(0);
    const atLeastOnce = await s.activate(tool('at-least-once'), 'plain');
    await s.executor.invoke(atLeastOnce, {}, s.ctx('e-1'));
    await s.executor.invoke(atLeastOnce, {}, s.ctx('e-2'));
    // The replay is a second effect, exactly as the tool declares: no exactly-once claim.
    expect(s.effects()).toBe(2);
  });
});
