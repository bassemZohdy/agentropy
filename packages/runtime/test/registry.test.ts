// AC-15 (registry part): immutable definitions, deterministic authorized discovery, distinct instances.
// Concurrent task execution on two instances of one definition is covered by the TaskService suite (FEAT-017).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_PROFILES,
  MemoryStore,
  isAgentropyError,
  type AgentDefinition,
  type PolicyDecisionPoint,
  type Store,
  type TrustedPrincipal,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@agentropy/store-sqlite';
import { DefinitionRegistry, InstanceDirectory } from '../src/registry.js';

const alice: TrustedPrincipal = { id: 'alice', type: 'user', tenantId: 't-1' };
const bob: TrustedPrincipal = { id: 'bob', type: 'user', tenantId: 't-1' };
const mallory: TrustedPrincipal = {
  id: 'mallory',
  type: 'user',
  tenantId: 't-2',
};

const def = (
  id: string,
  version = '1.0.0',
  over: Partial<AgentDefinition> = {},
): AgentDefinition => ({
  id,
  version,
  displayName: `${id} agent`,
  profile: { id: 'monitoring', version: '1.0.0' },
  implementation: {
    providerId: 'native-ts',
    providerVersion: '1.0.0',
    artifact: { id, version },
  },
  inputSchema: true,
  runtimeRequirements: { guarantees: [] },
  policyRef: { id: 'default', version: '1.0.0' },
  ...over,
});

const allowAll: PolicyDecisionPoint = {
  decide: async () => ({ effect: 'allow' }),
};
const denyIds = (ids: string[]): PolicyDecisionPoint => ({
  decide: async (r) =>
    ids.includes(r.resource.id) ? { effect: 'deny' } : { effect: 'allow' },
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return isAgentropyError(err) ? err.code : 'non-agentropy';
  }
  return 'no-error';
};

describe('DefinitionRegistry (AC-15, R-01, R-06)', () => {
  it('identical re-registration is a no-op; same id@version with different content fails', () => {
    const reg = new DefinitionRegistry(BUILTIN_PROFILES);
    reg.register(def('price-watch'));
    expect(reg.register(def('price-watch'))).toEqual(def('price-watch'));
    expect(
      code(() =>
        reg.register(def('price-watch', '1.0.0', { displayName: 'changed' })),
      ),
    ).toBe('InvalidConfiguration');
    reg.register(def('price-watch', '1.1.0'));
    expect(reg.versions('price-watch')).toEqual(['1.1.0', '1.0.0']);
  });

  it('registered definitions are immutable copies', () => {
    const reg = new DefinitionRegistry(BUILTIN_PROFILES);
    const d = def('a');
    reg.register(d);
    d.displayName = 'mutated';
    expect(reg.require({ id: 'a', version: '1.0.0' }).displayName).toBe(
      'a agent',
    );
    expect(code(() => reg.require({ id: 'ghost', version: '1.0.0' }))).toBe(
      'NotFound',
    );
  });

  it('rejects invalid definitions at registration', () => {
    expect(
      code(() =>
        new DefinitionRegistry(BUILTIN_PROFILES).register({
          ...def('a'),
          policyRef: undefined as never,
        }),
      ),
    ).toBe('SchemaViolation');
  });

  it('discovery is deterministic and filters by id, profile, capability and text', async () => {
    const reg = new DefinitionRegistry(BUILTIN_PROFILES);
    for (const d of [
      def('zeta'),
      def('alpha', '1.0.0'),
      def('alpha', '2.0.0'),
      def('beta', '1.0.0', {
        profile: { id: 'task', version: '1.0.0' },
        description: 'expense approval',
      }),
    ])
      reg.register(d);
    const all = await reg.discover({}, alice, allowAll);
    expect(all).toEqual([
      { id: 'alpha', version: '2.0.0' },
      { id: 'alpha', version: '1.0.0' },
      { id: 'beta', version: '1.0.0' },
      { id: 'zeta', version: '1.0.0' },
    ]);
    expect(await reg.discover({}, alice, allowAll)).toEqual(all);
    expect(
      await reg.discover({ capability: 'event-handling' }, alice, allowAll),
    ).toHaveLength(3);
    expect(await reg.discover({ profile: 'task' }, alice, allowAll)).toEqual([
      { id: 'beta', version: '1.0.0' },
    ]);
    expect(await reg.discover({ text: 'EXPENSE' }, alice, allowAll)).toEqual([
      { id: 'beta', version: '1.0.0' },
    ]);
  });

  it('hides definitions the caller may not see and fails closed on a PDP outage', async () => {
    const reg = new DefinitionRegistry(BUILTIN_PROFILES);
    reg.register(def('public'));
    reg.register(def('secret'));
    expect(await reg.discover({}, alice, denyIds(['secret']))).toEqual([
      { id: 'public', version: '1.0.0' },
    ]);
    await expect(
      reg.discover({}, alice, {
        decide: async () => Promise.reject(new Error('down')),
      }),
    ).rejects.toMatchObject({ code: 'PolicyDecisionUnavailable' });
  });

  it('declared capabilities apply profile defaults and removals', () => {
    const reg = new DefinitionRegistry(BUILTIN_PROFILES);
    expect(
      reg.declaredCapabilities(
        def('m', '1.0.0', {
          capabilities: [
            { id: 'scheduling', versionRange: '^1.0.0', remove: true },
            { id: 'reasoning', versionRange: '^1.0.0' },
          ],
        }),
      ),
    ).toEqual(['durability', 'event-handling', 'notification', 'reasoning']);
  });
});

describe('InstanceDirectory (R-01, R-13)', () => {
  const setup = (store: Store = new MemoryStore()) => {
    const reg = new DefinitionRegistry(BUILTIN_PROFILES);
    reg.register(def('price-watch'));
    return { reg, store, dir: new InstanceDirectory(reg, store) };
  };
  const ref = { id: 'price-watch', version: '1.0.0' };
  const acode = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return isAgentropyError(err) ? err.code : 'non-agentropy';
    }
    return 'no-error';
  };

  it('creates distinct logical identities from one definition; creation is idempotent per key', async () => {
    const { dir } = setup();
    const a = await dir.create(
      { definition: ref, ownerId: 'alice', idempotencyKey: 'k1' },
      alice,
    );
    const b = await dir.create(
      { definition: ref, ownerId: 'alice', idempotencyKey: 'k2' },
      alice,
    );
    expect(a.id).not.toBe(b.id);
    expect(
      await dir.create(
        { definition: ref, ownerId: 'alice', idempotencyKey: 'k1' },
        alice,
      ),
    ).toEqual(a);
    // Another owner under the same key is a different request; a user may not name another owner (FIX-057), so a
    // trusted service shows the conflict.
    const svc: TrustedPrincipal = {
      id: 'svc',
      type: 'service',
      tenantId: 't-1',
    };
    await dir.create(
      { definition: ref, ownerId: 'alice', idempotencyKey: 'k1' },
      svc,
    );
    expect(
      await acode(
        dir.create(
          { definition: ref, ownerId: 'bob', idempotencyKey: 'k1' },
          svc,
        ),
      ),
    ).toBe('IdempotencyConflict');
    expect(
      await acode(
        dir.create(
          { definition: ref, ownerId: 'bob', idempotencyKey: 'k1' },
          alice,
        ),
      ),
    ).toBe('PermissionDenied');
    expect(
      await acode(
        dir.create(
          {
            definition: { id: 'ghost', version: '1.0.0' },
            ownerId: 'alice',
            idempotencyKey: 'k3',
          },
          alice,
        ),
      ),
    ).toBe('NotFound');
  });

  it('suspend/resume/retire follow the instance table; other tenants and non-owners get NotFound', async () => {
    const { dir } = setup();
    const a = await dir.create(
      { definition: ref, ownerId: 'alice', idempotencyKey: 'k' },
      alice,
    );
    expect(await dir.suspend(a.id, alice)).toMatchObject({
      state: 'suspended',
      revision: 2,
    });
    expect(await acode(dir.suspend(a.id, alice))).toBe('InvalidState');
    expect((await dir.resume(a.id, alice)).state).toBe('available');
    expect(await acode(dir.suspend(a.id, bob))).toBe('NotFound');
    expect(await acode(dir.get(a.id, mallory))).toBe('NotFound');
    expect(
      await acode(dir.retire(a.id, alice, { hasActiveTasks: () => true })),
    ).toBe('InvalidState');
    expect(
      (
        await dir.retire(a.id, alice, {
          force: true,
          hasActiveTasks: () => true,
        })
      ).state,
    ).toBe('retired');
    expect(await acode(dir.resume(a.id, alice))).toBe('InvalidState');
    expect((await dir.list(alice)).map((i) => i.state)).toEqual(['retired']);
    expect(await dir.list(mallory)).toEqual([]);
  });

  it('instances and their idempotency survive a restart of a durable store (FEAT-018.1, R-08)', async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'agentropy-inst-')),
      'store.db',
    );
    const first = setup(new SqliteStore({ path }));
    const a = await first.dir.create(
      { definition: ref, ownerId: 'alice', idempotencyKey: 'k' },
      alice,
    );
    await first.dir.suspend(a.id, alice);
    await first.store.close();
    const second = setup(new SqliteStore({ path }));
    expect(await second.dir.get(a.id, alice)).toMatchObject({
      id: a.id,
      state: 'suspended',
      revision: 2,
    });
    expect(
      (
        await second.dir.create(
          { definition: ref, ownerId: 'alice', idempotencyKey: 'k' },
          alice,
        )
      ).id,
    ).toBe(a.id);
    await second.store.close();
  });
});
