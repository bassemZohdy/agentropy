/**
 * Local single-process composition (M1, ADR-0017): wires the Store, registries, TaskService, runtime pool,
 * wake-ups, outbox relay, inbox, human actions, audit forwarding and the built-in capability provider, and
 * exposes the Agent v1 `AgentService` operations as one facade. Examples and embedding applications use this
 * instead of assembling the services by hand. Trusted principals are supplied by the embedding ingress.
 */
import { randomUUID } from 'node:crypto';
import {
  AgentropyError,
  digestOf,
  BUILTIN_PROFILES,
  CAPABILITY_CATALOG,
  TASK_MACHINE,
  isTerminal,
  validateAgentDefinition,
  type Agent,
  type AgentDefinition,
  type AgentInstance,
  type AgentProfile,
  type AuditIntentWriter,
  type ConversationTurn,
  type HumanActionRequest,
  type HumanDecision,
  type InboxEntry,
  type InboxMarker,
  type PolicyDecisionPoint,
  type Store,
  type TaskEvent,
  type TaskHandle,
  type TaskSnapshot,
  type Telemetry,
  type ReasoningProvider,
  type WorkflowEngine,
  type ToolExecutor,
  type TrustedPrincipal,
  type DelegationRequest,
  type VersionedRef,
} from '@agentropy/core';
import { AuditForwarder, AuditService } from './audit.js';
import {
  HumanActionService,
  humanActionOperationHandlers,
} from './human-actions.js';
import {
  InMemoryHandlerRegistry,
  InMemoryImplementationProviderRegistry,
  NativeImplementationProvider,
} from './implementation.js';
import {
  InboxProjector,
  InboxService,
  inboxOperationHandlers,
} from './inbox.js';
import { OutboxRelay, TaskEventStream, type FaultHook } from './outbox.js';
import { type InboxPreferences, type PriorityPolicy } from './priority.js';
import { resolveLimits, type RuntimeLimits } from './limits.js';
import type { QuotaResolver } from './quotas.js';
import { CachingPolicyDecisionPoint } from './policy-cache.js';
import { reasoningOperationHandlers } from './reasoning.js';
import {
  bridgeWorkflowCompletions,
  workflowOperationHandlers,
} from './workflow.js';
import { DefinitionRegistry, InstanceDirectory } from './registry.js';
import { AgentRuntime, type RuntimeOptions } from './runtime.js';
import {
  TaskService,
  type GrantVerifier,
  type TaskRecord,
} from './task-service.js';
import {
  ToolUseCapability,
  type InMemoryToolRegistry,
  type ToolProviderRegistry,
} from './tools.js';
import {
  BuiltinCapabilityProvider,
  WakeupService,
  coreOperationHandlers,
  type OperationHandler,
} from './wakeups.js';

export interface LocalAppOptions {
  store: Store;
  /** Required: there is no implicit allow-all policy. */
  pdp: PolicyDecisionPoint;
  grants?: GrantVerifier;
  /** Sink for committed audit intents; without one they stay in the Store's `audit` collection. */
  audit?: AuditIntentWriter;
  now?: () => string;
  profiles?: readonly AgentProfile[];
  /** Tool registry, providers and executor backing `tool-use.listTools` / `tool-use.call`. */
  tools?: {
    registry: InMemoryToolRegistry;
    providers: ToolProviderRegistry;
    executor: ToolExecutor;
  };
  /** Model provider behind `reasoning.complete` (bounded tools and budget), e.g. `openAICompatibleReasoning(…)`. */
  reasoning?: ReasoningProvider;
  /** Deterministic workflow engine behind `workflow.start` / `workflow.status`; completions wake waiting tasks. */
  workflow?: WorkflowEngine;
  /** Extra built-in operation handlers, e.g. `complete` for `reasoning` backed by a model client. */
  operations?: Record<string, OperationHandler>;
  runtime?: Omit<
    RuntimeOptions,
    'tasks' | 'implementations' | 'capabilityProviders' | 'relay'
  >;
  /** Operational limits (D-05); validated at startup, see DEFAULT_LIMITS. */
  limits?: Partial<RuntimeLimits>;
  faults?: FaultHook;
  /** Spans and metrics (e.g. `openTelemetry({ api, tracer, meter })`); no-op by default. */
  telemetry?: Telemetry;
  /** Per-tenant quotas (M2-11): active tasks, accept rate, live instances. */
  quotas?: QuotaResolver;
  /** Relay leader lease, for several processes sharing one store (M2-06). */
  relay?: { relayId: string; leaseMs?: number };
  /** Unconsumed events kept per subscription before back-pressure drops (default 1000). */
  mailboxLimit?: number;
  /** Briefing policy, per-user preferences and urgent push (M2-04). */
  inbox?: {
    policy?: PriorityPolicy;
    preferences?: (
      user: TrustedPrincipal,
    ) => InboxPreferences | Promise<InboxPreferences>;
    push?: (entry: InboxEntry) => Promise<boolean>;
  };
}

export interface LocalApp {
  readonly store: Store;
  readonly definitions: DefinitionRegistry;
  readonly instances: InstanceDirectory;
  readonly tasks: TaskService;
  readonly runtime: AgentRuntime;
  readonly wakeups: WakeupService;
  readonly inbox: InboxService;
  readonly human: HumanActionService;
  readonly relay: OutboxRelay;
  /** Tenant-scoped audit read and hash-chain verification (needs `audit:read` / `audit:verify`). */
  readonly auditLog: AuditService;
  /** The effective, validated limits this app runs with. */
  readonly limits: RuntimeLimits;

  /** Register a definition and, for `native-ts` implementations, its handler. */
  define(definition: AgentDefinition, handler?: Agent<never, unknown>): void;

  // AgentService (Agent v1)
  /** `trace.traceparent`: optional W3C context from the caller's request (sanitized; never authorization). */
  delegate<I>(
    request: DelegationRequest<I>,
    caller: TrustedPrincipal,
    trace?: { traceparent?: string },
  ): Promise<TaskHandle>;
  getTask(taskId: string, caller: TrustedPrincipal): Promise<TaskSnapshot>;
  listTasks(
    query: {
      instanceId?: string;
      status?: TaskSnapshot['status'][];
      cursor?: string;
      limit?: number;
    },
    caller: TrustedPrincipal,
  ): Promise<{ tasks: TaskSnapshot[]; cursor: string }>;
  listInstances(
    caller: TrustedPrincipal,
    ownerId?: string,
  ): Promise<AgentInstance[]>;
  /** Owner-only: set the principals allowed to delegate to an instance (D-08). */
  shareInstance(
    instanceId: string,
    principalIds: string[],
    caller: TrustedPrincipal,
  ): Promise<AgentInstance>;
  /** Stop accepting new tasks; retire once the last task ends. */
  drainInstance(
    instanceId: string,
    caller: TrustedPrincipal,
  ): Promise<AgentInstance>;
  getTaskByIdempotencyKey(
    key: string,
    caller: TrustedPrincipal,
  ): Promise<TaskSnapshot>;
  getResult<O>(taskId: string, caller: TrustedPrincipal): Promise<O>;
  cancel(
    taskId: string,
    caller: TrustedPrincipal,
    reason?: string,
  ): Promise<TaskSnapshot>;
  subscribe(
    taskId: string,
    caller: TrustedPrincipal,
    from?: { revision: number; sequence: number },
  ): AsyncIterable<TaskEvent>;
  submitTurn(
    turn: ConversationTurn,
    caller: TrustedPrincipal,
  ): Promise<TaskHandle>;
  createInstance(
    req: { definition: VersionedRef; ownerId: string; idempotencyKey: string },
    caller: TrustedPrincipal,
  ): Promise<AgentInstance>;
  suspendInstance(
    instanceId: string,
    caller: TrustedPrincipal,
  ): Promise<AgentInstance>;
  resumeInstance(
    instanceId: string,
    caller: TrustedPrincipal,
  ): Promise<AgentInstance>;
  retireInstance(
    instanceId: string,
    caller: TrustedPrincipal,
    opts?: { force?: boolean },
  ): Promise<AgentInstance>;
  claimHumanAction(
    requestId: string,
    caller: TrustedPrincipal,
  ): Promise<HumanActionRequest>;
  releaseHumanAction(
    requestId: string,
    caller: TrustedPrincipal,
  ): Promise<HumanActionRequest>;
  getHumanAction(
    requestId: string,
    caller: TrustedPrincipal,
  ): Promise<HumanActionRequest>;
  provideHumanInput(
    decision: HumanDecision,
    caller: TrustedPrincipal,
  ): Promise<void>;
  listInbox(
    query: { cursor?: string; limit?: number },
    caller: TrustedPrincipal,
  ): Promise<{ entries: InboxEntry[]; cursor: string }>;
  markInbox(
    entryId: string,
    marker: InboxMarker,
    caller: TrustedPrincipal,
    presentedRevision?: number,
  ): Promise<void>;
  reauthorize(taskId: string, caller: TrustedPrincipal): Promise<void>;
  /**
   * D-20 revocation checkpoint (trusted services only): stop running work under a revoked grant, drop cached policy
   * decisions for it, and audit the revocation. Queued and future work is held by the dispatch gate.
   */
  revokeAuthority(
    grantRef: string,
    caller: TrustedPrincipal,
  ): Promise<{ signalled: string[]; invalidatedDecisions: number }>;
  /** Committed effects of a visible task (journal entries), e.g. to plan an authorized compensation. */
  listEffects(
    taskId: string,
    caller: TrustedPrincipal,
  ): Promise<{ operation: string; stepKey?: string; at: string }[]>;
  /** Operator compaction of consumed and expired runtime records (trusted services only). */
  compact(
    retainMs: number,
    caller: TrustedPrincipal,
  ): Promise<Awaited<ReturnType<WakeupService['compact']>>>;
  /** Operator reconciliation: re-project the inbox from committed events (trusted services only). */
  rebuildInbox(caller: TrustedPrincipal): Promise<{ created: number }>;

  /** Trusted event ingress (e.g. a price feed adapter); duplicate event IDs are ignored. */
  publishEvent(event: {
    eventId: string;
    source: string;
    tenantId: string;
    payload: unknown;
    traceparent?: string;
  }): Promise<boolean>;
  /** Poll wake-ups and run due work until nothing is left (bounded); for tests, examples and batch use. */
  runUntilIdle(maxRounds?: number): Promise<void>;
  /** Periodic scheduler loop for a long-running process; returns a stop function. */
  start(intervalMs?: number): () => Promise<void>;
}

export function createLocalApp(o: LocalAppOptions): LocalApp {
  const { skills: _skills, ...runtimeLimitFields } = o.runtime ?? {};
  void _skills;
  const limits = resolveLimits({
    ...(runtimeLimitFields as Partial<RuntimeLimits>),
    ...(o.mailboxLimit ? { mailboxLimit: o.mailboxLimit } : {}),
    ...o.limits,
  });
  const now = o.now ?? (() => new Date().toISOString());
  const store = o.store;
  const definitions = new DefinitionRegistry(o.profiles ?? BUILTIN_PROFILES);
  const instances = new InstanceDirectory(
    definitions,
    store,
    () => `inst-${randomUUID()}`,
    o.quotas,
  );
  const handlers = new InMemoryHandlerRegistry();
  const implementations = new InMemoryImplementationProviderRegistry();
  implementations.register(new NativeImplementationProvider(handlers));
  const builtinContracts = CAPABILITY_CATALOG.map((c) => ({
    id: c.id,
    version: c.version,
    ...(c.id === 'durability' ? { level: store.durability } : {}),
  }));
  const tasks = new TaskService({
    store,
    definitions,
    instances,
    pdp: o.pdp,
    ...(o.grants ? { grants: o.grants } : {}),
    now,
    limits: { maxDepth: limits.maxDepth, maxFanOut: limits.maxFanOut },
    ...(o.faults ? { faults: o.faults } : {}),
    ...(o.telemetry ? { telemetry: o.telemetry } : {}),
    ...(o.quotas ? { quotas: o.quotas } : {}),
    acceptance: {
      contracts: CAPABILITY_CATALOG,
      profiles: o.profiles ?? BUILTIN_PROFILES,
      providers: [
        { id: 'builtin', version: '1.0.0', contracts: builtinContracts },
      ],
      runtimeDurability: store.durability,
      implementationProvider: (id, v) => implementations.find(id, v),
      toolVersions: (id) => o.tools?.registry.versions(id) ?? [],
      toolProviderRegistered: (id, v) => o.tools?.providers.has(id, v) ?? false,
      skillVersions: () => [],
      pdp: o.pdp,
      now,
    },
  });
  const wakeups = new WakeupService(tasks, instances, {
    mailboxLimit: limits.mailboxLimit,
  });
  const inbox = new InboxService(tasks, {
    ...(o.inbox?.policy ? { policy: o.inbox.policy } : {}),
    ...(o.inbox?.preferences ? { preferences: o.inbox.preferences } : {}),
  });
  const projector = new InboxProjector(tasks, {
    ...(o.inbox?.policy ? { policy: o.inbox.policy } : {}),
    ...(o.inbox?.push ? { push: o.inbox.push } : {}),
  });
  const human = new HumanActionService(tasks);
  wakeups.addSweep(() => human.sweep());
  const stream = new TaskEventStream(tasks);
  const relay = new OutboxRelay({
    store,
    consumers: [projector, stream],
    ...(o.relay
      ? {
          relayId: o.relay.relayId,
          now,
          ...(o.relay.leaseMs ? { leaseMs: o.relay.leaseMs } : {}),
        }
      : {}),
    ...(o.telemetry ? { telemetry: o.telemetry, now } : {}),
    ...(o.faults ? { faults: o.faults } : {}),
  });
  const forwarder = o.audit
    ? new AuditForwarder({
        store,
        sink: o.audit,
        ...(o.faults ? { faults: o.faults } : {}),
      })
    : undefined;

  const toolHandlers: Record<string, OperationHandler> = o.tools
    ? {
        listTools: async (_input, ctx) =>
          new ToolUseCapability(
            o.tools!.executor,
            o.tools!.registry,
            (await taskOf(ctx.taskId)).snapshot.tools,
          ).listTools(),
        call: async (input, ctx) =>
          new ToolUseCapability(
            o.tools!.executor,
            o.tools!.registry,
            (await taskOf(ctx.taskId)).snapshot.tools,
          ).call(input as { toolId: string; input: unknown }, {
            tenantId: ctx.tenantId,
            taskId: ctx.taskId,
            executionId: ctx.executionId,
            principal: {
              id: ctx.principalId,
              type: 'agent',
              tenantId: ctx.tenantId,
              ...(ctx.delegatedAuthorityRef
                ? { delegatedAuthorityRef: ctx.delegatedAuthorityRef }
                : {}),
            },
            signal: ctx.signal,
            ...(ctx.idempotencyKey
              ? { idempotencyKey: ctx.idempotencyKey }
              : {}),
            ...(ctx.stepKey ? { stepKey: ctx.stepKey } : {}),
          }),
      }
    : {};
  async function hasActiveTasks(instanceId: string): Promise<boolean> {
    return (
      await store.transaction((tx) =>
        tx.find<TaskRecord>('tasks', { where: { instanceId } }),
      )
    ).some((t) => !isTerminal(TASK_MACHINE, t.value.status));
  }
  async function taskOf(taskId: string): Promise<TaskRecord> {
    const doc = await store.transaction((tx) =>
      tx.get<TaskRecord>('tasks', taskId),
    );
    if (!doc) throw new AgentropyError('NotFound', 'Task not found');
    return doc.value;
  }

  const builtin = new BuiltinCapabilityProvider({
    ...coreOperationHandlers(tasks, wakeups),
    ...inboxOperationHandlers(tasks, inbox),
    ...humanActionOperationHandlers(human),
    ...toolHandlers,
    ...(o.reasoning
      ? reasoningOperationHandlers({
          tasks,
          provider: o.reasoning,
          ...(o.tools ? { tools: o.tools.registry } : {}),
        })
      : {}),
    ...(o.workflow ? workflowOperationHandlers(o.workflow) : {}),
    ...o.operations,
  });
  const runtime = new AgentRuntime({
    ...o.runtime,
    poolSize: limits.poolSize,
    leaseMs: limits.leaseMs,
    cancelGraceMs: limits.cancelGraceMs,
    keepExecutions: limits.keepExecutions,
    maxCheckpointBytes: limits.maxCheckpointBytes,
    pdpTimeoutMs: limits.pdpTimeoutMs,
    gateRetry: limits.gateRetry,
    tasks,
    implementations,
    capabilityProviders: new Map([[builtin.id, builtin]]),
    relay: {
      drain: async () =>
        (await relay.drain()) + ((await forwarder?.drain()) ?? 0),
    },
  });

  if (o.workflow)
    bridgeWorkflowCompletions(o.workflow, (e) => wakeups.publish(e));
  const app: LocalApp = {
    store,
    definitions,
    instances,
    tasks,
    runtime,
    wakeups,
    inbox,
    human,
    relay,
    auditLog: new AuditService({ store, pdp: o.pdp }),
    limits,
    define(definition, handler) {
      const def = validateAgentDefinition(definition);
      if (def.implementation.providerId === 'native-ts') {
        if (!handler)
          throw new AgentropyError(
            'InvalidConfiguration',
            `Definition ${def.id}@${def.version} needs a native handler`,
          );
        handlers.register(def.implementation.artifact, handler as Agent);
      }
      definitions.register(def);
    },
    delegate: (r, c, trace) => tasks.delegate(r, c, trace),
    getTask: (id, c) => tasks.getTask(id, c),
    listTasks: (q, c) => tasks.listTasks(q, c),
    listInstances: (c, ownerId) => instances.list(c, ownerId),
    drainInstance: (id, c) => instances.drain(id, c),
    shareInstance: (id, ids, c) => instances.share(id, ids, c),
    getTaskByIdempotencyKey: (k, c) => tasks.getTaskByIdempotencyKey(k, c),
    getResult: (id, c) => tasks.getResult(id, c),
    cancel: (id, c, reason) => tasks.cancel(id, c, reason),
    subscribe: (id, c, from) => stream.subscribe(id, c, from),
    submitTurn: (t, c) => tasks.submitTurn(t, c),
    createInstance: (req, c) => instances.create(req, c),
    suspendInstance: (id, c) => instances.suspend(id, c),
    resumeInstance: (id, c) => instances.resume(id, c),
    retireInstance: (id, c, opts = {}) =>
      instances.retire(id, c, {
        ...opts,
        hasActiveTasks: () => hasActiveTasks(id),
      }),
    claimHumanAction: (id, c) => human.claim(id, c),
    releaseHumanAction: (id, c) => human.release(id, c),
    getHumanAction: (id, c) => human.get(id, c),
    provideHumanInput: (d, c) => human.decide(d, c),
    listInbox: (q, c) => inbox.list(q, c),
    markInbox: (id, m, c, rev) => inbox.mark(id, m, c, rev),
    reauthorize: (id, c) => tasks.reauthorize(id, c),
    async revokeAuthority(grantRef, caller) {
      if (caller?.type !== 'service')
        throw new AgentropyError(
          'PermissionDenied',
          'Revoking authority is an operator action',
        );
      const signalled = await runtime.revokeAuthority(
        grantRef,
        caller.tenantId,
      );
      const invalidatedDecisions =
        o.pdp instanceof CachingPolicyDecisionPoint
          ? o.pdp.invalidate({ tenantId: caller.tenantId, grantRef })
          : 0;
      await store.transaction((tx) =>
        tasks.audit(tx, caller, {
          type: 'authority.revoke',
          action: 'grant:revoke',
          // The reference itself stays out of the audit trail; its digest identifies it.
          resource: { type: 'grant', id: digestOf(grantRef) },
          decision: 'allow',
          details: { signalled: signalled.length, invalidatedDecisions },
        }),
      );
      return { signalled, invalidatedDecisions };
    },
    async listEffects(taskId, caller) {
      await tasks.visible(taskId, caller);
      const rows = await store.transaction((tx) =>
        tx.find<{ operation: string; stepKey?: string; at: string }>(
          'effects',
          { where: { taskId }, orderBy: 'seq' },
        ),
      );
      return rows.map((r) => ({
        operation: r.value.operation,
        ...(r.value.stepKey ? { stepKey: r.value.stepKey } : {}),
        at: r.value.at,
      }));
    },
    async compact(retainMs, caller) {
      if (caller?.type !== 'service')
        throw new AgentropyError(
          'PermissionDenied',
          'Compaction is an operator action',
        );
      return wakeups.compact(retainMs);
    },
    async rebuildInbox(caller) {
      if (caller?.type !== 'service')
        throw new AgentropyError(
          'PermissionDenied',
          'Inbox rebuild is an operator action',
        );
      return { created: await projector.rebuild() };
    },
    publishEvent: (e) => wakeups.publish(e),
    async runUntilIdle(maxRounds = 20) {
      for (let i = 0; i < maxRounds; i++) {
        const fired = await wakeups.poll();
        await runtime.runUntilIdle();
        if (fired === 0 && runtime.activeCount === 0) {
          const again = await wakeups.poll();
          if (again === 0) return;
          await runtime.runUntilIdle();
        }
      }
    },
    start(intervalMs = 250) {
      let stopped = false;
      let running: Promise<void> = Promise.resolve();
      const timer = setInterval(() => {
        if (stopped) return;
        running = running.then(async () => {
          await wakeups.poll();
          await runtime.tick();
        });
      }, intervalMs);
      return async () => {
        stopped = true;
        clearInterval(timer);
        await running;
        await runtime.idle();
      };
    },
  };
  return app;
}
