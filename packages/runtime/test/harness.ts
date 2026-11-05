/** Shared offline harness for runtime suites: fake clock/policy/grants, SQLite temp store, registries. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_PROFILES,
  CAPABILITY_CATALOG,
  MemoryStore,
  type Agent,
  type AgentDefinition,
  type AgentImplementationProvider,
  type CapabilityProvider,
  type Store,
  type TrustedPrincipal,
} from '@agentropy/core';
import { SqliteStore } from '@agentropy/store-sqlite';
import { FakeClock, FakeGrants, FakePolicy } from '@agentropy/testkit';
import {
  InMemoryHandlerRegistry,
  InMemoryImplementationProviderRegistry,
  NativeImplementationProvider,
} from '../src/implementation.js';
import { DefinitionRegistry, InstanceDirectory } from '../src/registry.js';
import { AgentRuntime } from '../src/runtime.js';
import { TaskService } from '../src/task-service.js';

export const alice: TrustedPrincipal = {
  id: 'alice',
  type: 'user',
  tenantId: 't-1',
};
export const bob: TrustedPrincipal = {
  id: 'bob',
  type: 'user',
  tenantId: 't-1',
};
export const mallory: TrustedPrincipal = {
  id: 'mallory',
  type: 'user',
  tenantId: 't-2',
};

export class RecordingCapability implements CapabilityProvider {
  readonly id = 'builtin';
  readonly version = '1.0.0';
  readonly contracts = CAPABILITY_CATALOG.map((c) => ({
    id: c.id,
    version: c.version,
    ...(c.id === 'durability' ? { level: 'durable-execution' } : {}),
  }));
  readonly calls: {
    operation: string;
    input: unknown;
    idempotencyKey?: string;
  }[] = [];
  async invoke<I, O>(
    operation: string,
    input: I,
    ctx: { idempotencyKey?: string },
  ): Promise<O> {
    this.calls.push({
      operation,
      input,
      ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
    });
    return { ok: true } as O;
  }
}

export function sqliteTempStore(): SqliteStore {
  return new SqliteStore({
    path: join(mkdtempSync(join(tmpdir(), 'agentropy-rt-')), 'store.db'),
  });
}

export interface HarnessOptions {
  store?: Store;
  extraProviders?: AgentImplementationProvider[];
  poolSize?: number;
  cancelGraceMs?: number;
  limits?: { maxDepth?: number; maxFanOut?: number };
}

export function harness(o: HarnessOptions = {}) {
  const clock = new FakeClock();
  const store = o.store ?? sqliteTempStore();
  const pdp = new FakePolicy();
  const grants = new FakeGrants();
  const definitions = new DefinitionRegistry(BUILTIN_PROFILES);
  const instances = new InstanceDirectory(definitions);
  const handlers = new InMemoryHandlerRegistry();
  const implementations = new InMemoryImplementationProviderRegistry();
  implementations.register(new NativeImplementationProvider(handlers));
  for (const p of o.extraProviders ?? []) implementations.register(p);
  const cap = new RecordingCapability();
  let ids = 0;
  const tasks = new TaskService({
    store,
    definitions,
    instances,
    pdp,
    grants,
    now: clock.now,
    newId: (kind) => `${kind}-${++ids}`,
    ...(o.limits ? { limits: o.limits } : {}),
    acceptance: {
      contracts: CAPABILITY_CATALOG,
      profiles: BUILTIN_PROFILES,
      providers: [
        { id: cap.id, version: cap.version, contracts: cap.contracts },
      ],
      runtimeDurability: store.durability,
      implementationProvider: (id, v) => implementations.find(id, v),
      toolVersions: () => [],
      toolProviderRegistered: () => false,
      skillVersions: () => [],
      pdp,
      now: clock.now,
    },
  });
  const runtime = new AgentRuntime({
    tasks,
    implementations,
    capabilityProviders: new Map([[cap.id, cap]]),
    poolSize: o.poolSize ?? 4,
    leaseMs: 1_000,
    cancelGraceMs: o.cancelGraceMs ?? 20,
  });

  const define = (
    id: string,
    handler: Agent,
    over: Partial<AgentDefinition> = {},
    version = '1.0.0',
  ) => {
    const def: AgentDefinition = {
      id,
      version,
      displayName: id,
      profile: { id: 'task', version: '1.0.0' },
      implementation: {
        providerId: 'native-ts',
        providerVersion: '1.0.0',
        artifact: { id, version },
      },
      inputSchema: true,
      runtimeRequirements: { guarantees: [] },
      policyRef: { id: 'default', version: '1.0.0' },
      retryPolicy: {
        maxAttempts: 3,
        backoff: { initialMs: 1000, maxMs: 10_000, multiplier: 2 },
      },
      ...over,
    };
    if (def.implementation.providerId === 'native-ts')
      handlers.register(def.implementation.artifact, handler);
    definitions.register(def);
    return def;
  };
  const instance = (
    definitionId: string,
    owner: TrustedPrincipal = alice,
    version = '1.0.0',
  ) =>
    instances.create(
      {
        definition: { id: definitionId, version },
        ownerId: owner.id,
        idempotencyKey: `${definitionId}-${owner.id}-${version}-${++ids}`,
      },
      owner,
    );
  const delegate = (
    instanceId: string,
    input: unknown,
    key: string,
    caller: TrustedPrincipal = alice,
    extra: Record<string, unknown> = {},
  ) =>
    tasks.delegate(
      {
        target: { instanceId },
        input,
        idempotencyKey: key,
        correlationId: `corr-${key}`,
        ...extra,
      },
      caller,
    );

  return {
    clock,
    store,
    pdp,
    grants,
    definitions,
    instances,
    handlers,
    implementations,
    cap,
    tasks,
    runtime,
    define,
    instance,
    delegate,
  };
}

export { MemoryStore };

export async function code(
  p: Promise<unknown> | (() => unknown),
): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'no-error';
  } catch (err) {
    const c = (err as { code?: string }).code;
    return typeof c === 'string' ? c : `non-agentropy: ${String(err)}`;
  }
}

export const completes = (output: unknown = { ok: true }): Agent => ({
  handle: async () => ({ kind: 'completed', output }),
});
