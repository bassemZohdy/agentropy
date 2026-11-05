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
import {
  FakeAudit,
  FakeClock,
  FakeGrants,
  FakePolicy,
} from '@agentropy/testkit';
import {
  InMemoryHandlerRegistry,
  InMemoryImplementationProviderRegistry,
  NativeImplementationProvider,
} from '../src/implementation.js';
import { AuditForwarder } from '../src/audit.js';
import {
  HumanActionService,
  humanActionOperationHandlers,
} from '../src/human-actions.js';
import {
  InboxProjector,
  InboxService,
  inboxOperationHandlers,
} from '../src/inbox.js';
import { OutboxRelay, TaskEventStream, type FaultHook } from '../src/outbox.js';
import { DefinitionRegistry, InstanceDirectory } from '../src/registry.js';
import { AgentRuntime } from '../src/runtime.js';
import { TaskService } from '../src/task-service.js';
import {
  BuiltinCapabilityProvider,
  WakeupService,
  coreOperationHandlers,
} from '../src/wakeups.js';

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
  /** Use the real built-in delegation/event/scheduling handlers instead of the recording fake. */
  builtin?: boolean;
  /** Runtime overrides (e.g. checkpoint limit, execution history). */
  runtime?: { maxCheckpointBytes?: number; keepExecutions?: number };
  /** Fault hook passed to the outbox relay. */
  faults?: FaultHook;
}

let harnessRun = 0;

export function harness(o: HarnessOptions = {}) {
  const run = ++harnessRun;
  const clock = new FakeClock('2026-11-05T00:00:00.000Z');
  const store = o.store ?? sqliteTempStore();
  const pdp = new FakePolicy();
  const grants = new FakeGrants();
  const definitions = new DefinitionRegistry(BUILTIN_PROFILES);
  const instances = new InstanceDirectory(definitions, store);
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
    now: clock.iso,
    newId: (kind) => `${kind}-${run}-${++ids}`,
    ...(o.faults ? { faults: o.faults } : {}),
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
      now: clock.iso,
    },
  });
  const wakeups = new WakeupService(tasks, instances);
  const inbox = new InboxService(tasks);
  const human = new HumanActionService(tasks);
  wakeups.addSweep(() => human.sweep());
  const projector = new InboxProjector(tasks);
  const stream = new TaskEventStream(tasks);
  const audit = new FakeAudit();
  const forwarder = new AuditForwarder({
    store,
    sink: audit,
    ...(o.faults ? { faults: o.faults } : {}),
  });
  const relay = new OutboxRelay({
    store,
    consumers: [projector, stream],
    ...(o.faults ? { faults: o.faults } : {}),
  });
  const builtin = new BuiltinCapabilityProvider({
    ...coreOperationHandlers(tasks, wakeups),
    ...inboxOperationHandlers(tasks, inbox),
    ...humanActionOperationHandlers(human),
  });
  const runtime = new AgentRuntime({
    tasks,
    implementations,
    capabilityProviders: new Map<string, CapabilityProvider>([
      [cap.id, o.builtin ? builtin : cap],
    ]),
    poolSize: o.poolSize ?? 4,
    leaseMs: 1_000,
    cancelGraceMs: o.cancelGraceMs ?? 20,
    ...o.runtime,
    relay: {
      drain: async () => (await relay.drain()) + (await forwarder.drain()),
    },
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
    wakeups,
    inbox,
    human,
    relay,
    audit,
    forwarder,
    stream,
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
export { SqliteStore };
