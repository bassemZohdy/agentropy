// FEAT-045.2: the reference `memory` capability provider (Capability v1 rev 14, "Memory provider"): `remember` and
// `recall` on the Store port, scoped to tenant and acting principal, bounded, retained by TTL and removed by compact().
import {
  BUILTIN_PROFILES,
  type Agent,
  type AgentDefinition,
  type CapabilityInvocationContext,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import {
  createLocalApp,
  memoryOperationHandlers,
} from '../../runtime/src/index.js';
import { code, sqliteTempStore } from '../../runtime/test/harness.js';
import { FakeClock, FakePolicy } from '../src/index.js';

type Entry = {
  key: string;
  text: string;
  tags: string[];
  rememberedAt: string;
  expiresAt?: string;
};

function memory(o: { maxEntries?: number; defaultTtlMs?: number } = {}) {
  const clock = new FakeClock('2026-11-11T00:00:00.000Z');
  const store = sqliteTempStore();
  const h = memoryOperationHandlers({ store, now: clock.iso, ...o });
  const ctx = (
    over: Partial<CapabilityInvocationContext> = {},
  ): CapabilityInvocationContext => ({
    tenantId: 't-1',
    taskId: 'task-1',
    executionId: 'x-1',
    principalId: 'agent-a',
    signal: new AbortController().signal,
    ...over,
  });
  const remember = (
    input: Record<string, unknown>,
    over?: Partial<CapabilityInvocationContext>,
  ) =>
    h['remember']!(input, ctx(over)) as Promise<{
      key: string;
      replaced: boolean;
    }>;
  const recall = async (
    input: Record<string, unknown> = {},
    over?: Partial<CapabilityInvocationContext>,
  ) => ((await h['recall']!(input, ctx(over))) as { entries: Entry[] }).entries;
  return { clock, store, remember, recall };
}

describe('memory provider (FEAT-045.2)', () => {
  it('remembers and recalls by key, tag and query, newest first, with a limit', async () => {
    const m = memory();
    await m.remember({
      key: 'a',
      text: 'Alpha budget is 10',
      tags: ['budget'],
    });
    m.clock.advanceBy(1_000);
    await m.remember({
      key: 'b',
      text: 'beta BUDGET is 20',
      tags: ['budget', 'q4'],
    });
    m.clock.advanceBy(1_000);
    await m.remember({
      key: 'c',
      text: 'gamma owner is Eve',
      tags: ['people'],
    });
    expect((await m.recall()).map((e) => e.key)).toEqual(['c', 'b', 'a']);
    expect((await m.recall({ key: 'a' })).map((e) => e.key)).toEqual(['a']);
    expect((await m.recall({ tag: 'budget' })).map((e) => e.key)).toEqual([
      'b',
      'a',
    ]);
    expect((await m.recall({ query: 'budget' })).map((e) => e.key)).toEqual([
      'b',
      'a',
    ]);
    expect(
      (await m.recall({ tag: 'budget', query: 'beta' })).map((e) => e.key),
    ).toEqual(['b']);
    expect((await m.recall({ limit: 1 })).map((e) => e.key)).toEqual(['c']);
    expect(await m.recall({ query: 'nothing like this' })).toEqual([]);
    expect(await m.recall({ key: 'a' })).toMatchObject([
      {
        key: 'a',
        text: 'Alpha budget is 10',
        tags: ['budget'],
        rememberedAt: '2026-11-11T00:00:00.000Z',
      },
    ]);
  });

  it('the same key replaces the entry and counts once', async () => {
    const m = memory({ maxEntries: 1 });
    expect(await m.remember({ key: 'k', text: 'one' })).toEqual({
      key: 'k',
      replaced: false,
    });
    expect(await m.remember({ key: 'k', text: 'two', tags: ['t'] })).toEqual({
      key: 'k',
      replaced: true,
    });
    expect(await m.recall()).toMatchObject([
      { key: 'k', text: 'two', tags: ['t'] },
    ]);
  });

  it('without a key the step key names the entry, so a replayed step stores once; with neither it is refused', async () => {
    const m = memory();
    const first = await m.remember({ text: 'note' }, { stepKey: 'step-1' });
    const again = await m.remember({ text: 'note' }, { stepKey: 'step-1' });
    expect(again.key).toBe(first.key);
    expect(again.replaced).toBe(true);
    expect(await m.recall()).toHaveLength(1);
    expect(await code(m.remember({ text: 'note' }))).toBe('SchemaViolation');
  });

  it('refuses input outside the bounds, and a new key beyond the quota', async () => {
    const m = memory({ maxEntries: 2 });
    const bad: Record<string, unknown>[] = [
      { key: 'k', text: '' },
      { key: 'k', text: 42 },
      { key: 'k', text: 'x'.repeat(8 * 1024 + 1) },
      { key: 'k', text: '€'.repeat(2_800) }, // 8,400 bytes in 2,800 characters
      { key: '', text: 'x' },
      { key: 'has space', text: 'x' },
      { key: 'k'.repeat(129), text: 'x' },
      { key: 'k', text: 'x', tags: ['UPPER'] },
      {
        key: 'k',
        text: 'x',
        tags: Array.from({ length: 9 }, (_, i) => `t${i}`),
      },
      { key: 'k', text: 'x', tags: ['t'.repeat(65)] },
      { key: 'k', text: 'x', ttlMs: 0 },
      { key: 'k', text: 'x', ttlMs: 1.5 },
    ];
    for (const input of bad)
      expect(
        await code(m.remember(input)),
        JSON.stringify(input).slice(0, 60),
      ).toBe('SchemaViolation');
    for (const limit of [0, 21, 1.5, '3'])
      expect(await code(m.recall({ limit }))).toBe('SchemaViolation');
    expect(await m.recall()).toEqual([]);
    await m.remember({ key: 'a', text: 'x' });
    await m.remember({ key: 'b', text: 'x' });
    expect(await code(m.remember({ key: 'c', text: 'x' }))).toBe(
      'QuotaExceeded',
    );
    await m.remember({ key: 'a', text: 'replaced is fine' });
    expect(await m.recall()).toHaveLength(2);
  });

  it('retention: an expired entry is invisible at once; the default TTL applies; no TTL is durable', async () => {
    const m = memory({ defaultTtlMs: 60_000 });
    await m.remember({ key: 'short', text: 'a', ttlMs: 1_000 });
    await m.remember({ key: 'default', text: 'b' });
    expect(await m.recall({ key: 'short' })).toMatchObject([
      { expiresAt: '2026-11-11T00:00:01.000Z' },
    ]);
    m.clock.advanceBy(1_001);
    expect(await m.recall({ key: 'short' })).toEqual([]);
    expect((await m.recall()).map((e) => e.key)).toEqual(['default']);
    m.clock.advanceBy(60_000);
    expect(await m.recall()).toEqual([]);
    const durable = memory();
    await durable.remember({ key: 'forever', text: 'x' });
    durable.clock.advanceBy(10 * 365 * 24 * 3_600_000);
    expect((await durable.recall())[0]).not.toHaveProperty('expiresAt');
    expect(await durable.recall()).toHaveLength(1);
  });

  it('is scoped to tenant and principal: nobody else reads or overwrites an entry', async () => {
    const m = memory();
    await m.remember({ key: 'secret', text: 'agent A only' });
    expect(await m.recall({}, { principalId: 'agent-b' })).toEqual([]);
    expect(await m.recall({}, { tenantId: 't-2' })).toEqual([]);
    expect(
      await m.recall(
        { key: 'secret' },
        { tenantId: 't-2', principalId: 'agent-b' },
      ),
    ).toEqual([]);
    // The same key under another scope is a different entry, not a replacement.
    expect(
      await m.remember(
        { key: 'secret', text: 'agent B' },
        { principalId: 'agent-b' },
      ),
    ).toMatchObject({ replaced: false });
    expect(
      await m.remember(
        { key: 'secret', text: 'tenant 2' },
        { tenantId: 't-2' },
      ),
    ).toMatchObject({ replaced: false });
    expect((await m.recall())[0]!.text).toBe('agent A only');
    expect((await m.recall({}, { principalId: 'agent-b' }))[0]!.text).toBe(
      'agent B',
    );
  });

  describe('through the capability', () => {
    const alice: TrustedPrincipal = {
      id: 'alice',
      type: 'user',
      tenantId: 't-1',
    };
    const def = (id: string): AgentDefinition => ({
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
      capabilities: [{ id: 'memory', versionRange: '^1.0.0' }],
    });

    async function rig() {
      const clock = new FakeClock('2026-11-11T00:00:00.000Z');
      const app = createLocalApp({
        store: sqliteTempStore(),
        pdp: new FakePolicy(),
        now: clock.iso,
        profiles: BUILTIN_PROFILES,
        memory: { defaultTtlMs: 60_000 },
      });
      const notebook: Agent<{ remember?: string; recall?: string }> = {
        handle: async (inv, ctx) => {
          const out: Record<string, unknown> = {};
          if (inv.input.remember)
            out['stored'] = await ctx.capabilities.invoke(
              'memory',
              'remember',
              { key: 'fact', text: inv.input.remember, tags: ['fact'] },
              { stepKey: 'remember' },
            );
          if (inv.input.recall !== undefined)
            out['recalled'] = await ctx.capabilities.invoke(
              'memory',
              'recall',
              {
                query: inv.input.recall,
              },
            );
          return { kind: 'completed', output: out };
        },
      };
      for (const id of ['notebook-a', 'notebook-b'])
        app.define(def(id), notebook);
      const instances = new Map<string, string>();
      const run = async (
        id: string,
        input: Record<string, unknown>,
        key: string,
      ) => {
        let instanceId = instances.get(id);
        if (!instanceId) {
          instanceId = (
            await app.createInstance(
              {
                definition: { id, version: '1.0.0' },
                ownerId: 'alice',
                idempotencyKey: `i-${id}`,
              },
              alice,
            )
          ).id;
          instances.set(id, instanceId);
        }
        const t = await app.delegate(
          {
            target: { instanceId },
            input,
            idempotencyKey: key,
            correlationId: key,
          },
          alice,
        );
        await app.runUntilIdle();
        return (await app.getResult(t.taskId, alice)) as {
          recalled?: { entries: Entry[] };
        };
      };
      return { app, clock, run };
    }

    it('an agent recalls in a later task what it remembered in an earlier one; another agent cannot', async () => {
      const r = await rig();
      await r.run('notebook-a', { remember: 'the vault code is 4711' }, 'k1');
      const later = await r.run('notebook-a', { recall: 'vault' }, 'k2');
      expect(later.recalled?.entries.map((e) => e.text)).toEqual([
        'the vault code is 4711',
      ]);
      const other = await r.run('notebook-b', { recall: 'vault' }, 'k3');
      expect(other.recalled?.entries).toEqual([]);
    });

    it('compact() removes expired entries and keeps the live ones', async () => {
      const r = await rig();
      await r.run('notebook-a', { remember: 'short lived' }, 'k1');
      const count = async () =>
        (await r.app.store.transaction((tx) => tx.find('memories', {}))).length;
      expect(await count()).toBe(1);
      const ops: TrustedPrincipal = {
        id: 'ops',
        type: 'service',
        tenantId: 't-1',
      };
      expect(await r.app.compact(1_000, ops)).toMatchObject({ memories: 0 });
      expect(await count()).toBe(1);
      r.clock.advanceBy(61_000);
      expect(await r.app.compact(1_000, ops)).toMatchObject({ memories: 1 });
      expect(await count()).toBe(0);
    });
  });
});
