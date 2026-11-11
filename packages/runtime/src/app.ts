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
  enforcePolicy,
  BUILTIN_PROFILES,
  CAPABILITY_CATALOG,
  METRICS,
  TASK_MACHINE,
  isTerminal,
  toAgentropyError,
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
  type CommunicationRouter,
  type ReasoningProvider,
  type WorkflowEngine,
  type ToolExecutor,
  type TrustedPrincipal,
  type DelegationRequest,
  type VersionedRef,
} from '@agentropy/core';
import {
  AuditForwarder,
  AuditService,
  type AuditAnchorSink,
  type AuditRetention,
} from './audit.js';
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
import {
  CachingPolicyDecisionPoint,
  recordPolicyInvalidation,
} from './policy-cache.js';
import { memoryOperationHandlers, type MemoryOptions } from './memory.js';
import { reasoningOperationHandlers } from './reasoning.js';
import { RemoteDelegationService, type RemoteSyncOptions } from './remote.js';
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
  FileSystemSkillLoader,
  PinnedSkillAccess,
  type InMemorySkillRegistry,
} from './skills.js';
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
  /** Deployment audit retention and floor (ADR-0022 §4; default 365 days, floor 30). */
  auditRetention?: AuditRetention;
  /** Independently protected sink for audit chain anchors (ADR-0022 §7). */
  auditAnchors?: AuditAnchorSink;
  now?: () => string;
  profiles?: readonly AgentProfile[];
  /** Tool registry, providers and executor backing `tool-use.listTools` / `tool-use.call`. */
  tools?: {
    registry: InMemoryToolRegistry;
    providers: ToolProviderRegistry;
    executor: ToolExecutor;
  };
  /**
   * Skill registry (and loader, default `FileSystemSkillLoader`): definitions may then select `skills`, which are
   * pinned at acceptance and readable through `AgentContext.skills` (FEAT-041.1).
   */
  skills?: {
    registry: InMemorySkillRegistry;
    loader?: FileSystemSkillLoader;
  };
  /** Model provider behind `reasoning.complete` (bounded tools and budget), e.g. `openAICompatibleReasoning(…)`. */
  reasoning?: ReasoningProvider;
  /** Enables the reference `memory` capability (`remember`, `recall`) on the store (FEAT-045). */
  memory?: MemoryOptions;
  /** Deterministic workflow engine behind `workflow.start` / `workflow.status`; completions wake waiting tasks. */
  workflow?: WorkflowEngine;
  /** Minimum time between polls of a workflow engine that implements `poll` (default 5 s). */
  workflowPollMs?: number;
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
  /** Router for remote delegation targets (`target.remote`), with A2A or custom providers registered (FEAT-027.9). */
  communication?: {
    router: CommunicationRouter;
    /** Refresh pace of remote task projections (default 1 s after a change, doubling to 30 s when quiet). */
    sync?: RemoteSyncOptions;
  };
  /** Per-tenant quotas (M2-11): active tasks, accept rate, live instances. */
  quotas?: QuotaResolver;
  /** Relay leader lease, for several processes sharing one store (M2-06). */
  relay?: { relayId: string; leaseMs?: number };
  /** Give up on an outbox row after this many failed deliveries (default: never; see `OutboxRelayOptions.poisonAfter`). */
  outboxPoisonAfter?: number;
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

/**
 * State of the loop `LocalApp.start()` runs (FEAT-037.1). A tick that throws (a store outage, a bug) is counted
 * and reported, and the loop goes on; readiness probes read this to tell a live loop from a stalled one.
 */
export interface SchedulerStatus {
  /** True between `start()` and the returned stop function settling. */
  running: boolean;
  startedAt?: string;
  intervalMs?: number;
  /** When the last tick completed without error. */
  lastTickAt?: string;
  /** Ticks that failed since the last successful one. */
  consecutiveFailures: number;
  /** Errors v1 code of the last failed tick, cleared by the next successful one. */
  lastError?: string;
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
  /**
   * Audited upgrade or rollback of the definition version an instance uses for future tasks (FEAT-028.3). Accepted
   * tasks stay pinned to their snapshot. Policy action `agent:upgrade`.
   */
  upgradeInstance(
    instanceId: string,
    change: { version: string; expectedRevision: number },
    caller: TrustedPrincipal,
  ): Promise<AgentInstance>;
  /**
   * Trusted services: which versions of a definition are still referenced in the caller's tenant, by live instances
   * and by non-terminal tasks — a version can be removed once both counts are zero (D-07 retirement constraint).
   */
  versionsInUse(
    definitionId: string,
    caller: TrustedPrincipal,
  ): Promise<{ version: string; instances: number; activeTasks: number }[]>;
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
  /** Ends after the terminal event, or when `options.signal` aborts. */
  subscribe(
    taskId: string,
    caller: TrustedPrincipal,
    from?: { revision: number; sequence: number },
    options?: { signal?: AbortSignal },
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
  /**
   * Periodic scheduler loop for a long-running process; returns a stop function that waits for the current tick
   * and the running executions and never rejects. A tick that throws is counted (`agentropy.scheduler.errors`),
   * handed to `options.onError` and does not stop the loop (FEAT-037.1).
   */
  start(
    intervalMs?: number,
    options?: { onError?: (error: AgentropyError) => void },
  ): () => Promise<void>;
  /** Snapshot of the loop's health: last successful tick, failures in a row, last error code. */
  schedulerStatus(): SchedulerStatus;
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
    limits: {
      maxDepth: limits.maxDepth,
      maxFanOut: limits.maxFanOut,
      maxInputBytes: limits.maxInputBytes,
    },
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
      skillVersions: (id) => o.skills?.registry.versions(id) ?? [],
      pdp: o.pdp,
      now,
    },
  });
  const wakeups = new WakeupService(tasks, instances, {
    mailboxLimit: limits.mailboxLimit,
    maxEventBytes: limits.maxEventBytes,
  });
  const inbox = new InboxService(tasks, {
    ...(o.inbox?.policy ? { policy: o.inbox.policy } : {}),
    ...(o.inbox?.preferences ? { preferences: o.inbox.preferences } : {}),
  });
  const projector = new InboxProjector(tasks, {
    ...(o.inbox?.policy ? { policy: o.inbox.policy } : {}),
    ...(o.inbox?.push ? { push: o.inbox.push } : {}),
  });
  const human = new HumanActionService(tasks, {
    maxPromptBytes: limits.maxPromptBytes,
  });
  wakeups.addSweep(() => human.sweep());
  const remote = o.communication
    ? new RemoteDelegationService({
        tasks,
        router: o.communication.router,
        ...(o.communication.sync ? { sync: o.communication.sync } : {}),
      })
    : undefined;
  // Remote projections refresh before wake-ups are evaluated, so a parent waiting on a remote child wakes promptly.
  if (remote) wakeups.addSweep(() => remote.sync());
  const stream = new TaskEventStream(tasks);
  const relay = new OutboxRelay({
    store,
    consumers: [projector],
    // Subscription wake-ups are per process: with a relay lease every worker still wakes its own subscribers.
    localConsumers: [stream],
    ...(o.relay
      ? {
          relayId: o.relay.relayId,
          now,
          ...(o.relay.leaseMs ? { leaseMs: o.relay.leaseMs } : {}),
        }
      : {}),
    ...(o.outboxPoisonAfter ? { poisonAfter: o.outboxPoisonAfter } : {}),
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
  function isRemote(taskId: string): boolean {
    return !!remote && taskId.includes(':');
  }
  function remoteOrFail(): RemoteDelegationService {
    if (!remote)
      throw new AgentropyError(
        'NoCompatibleRoute',
        'No communication router is configured for remote targets',
      );
    return remote;
  }
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
    ...coreOperationHandlers(tasks, wakeups, remote),
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
    ...(o.workflow
      ? workflowOperationHandlers(o.workflow, { store, now })
      : {}),
    ...(o.memory ? memoryOperationHandlers({ store, now, ...o.memory }) : {}),
    ...o.operations,
  });
  const skillLoader =
    o.skills &&
    (o.skills.loader ?? new FileSystemSkillLoader(o.skills.registry));
  const runtime = new AgentRuntime({
    ...(o.skills && skillLoader
      ? {
          skills: (task: TaskRecord) =>
            new PinnedSkillAccess(
              skillLoader,
              o.skills!.registry,
              task.snapshot.skills,
            ),
        }
      : {}),
    ...o.runtime,
    poolSize: limits.poolSize,
    leaseMs: limits.leaseMs,
    cancelGraceMs: limits.cancelGraceMs,
    maxActivationMs: limits.maxActivationMs,
    maxOutputBytes: limits.maxOutputBytes,
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

  if (o.workflow) {
    bridgeWorkflowCompletions(o.workflow, (e) => wakeups.publish(e), {
      onError: (err) => runtime.report(err),
    });
    // Engines that cannot push are polled as a scheduler sweep, at most every workflowPollMs (FEAT-038.2).
    const engine = o.workflow;
    let lastPoll = -Infinity;
    if (engine.poll)
      wakeups.addSweep(async () => {
        const at = Date.parse(now());
        if (at - lastPoll < (o.workflowPollMs ?? 5_000)) return;
        lastPoll = at;
        await engine.poll!();
      });
  }
  const scheduler: SchedulerStatus = { running: false, consecutiveFailures: 0 };
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
    auditLog: new AuditService({
      store,
      pdp: o.pdp,
      now,
      newId: () => tasks.newId('audit'),
      ...(o.auditRetention ? { retention: o.auditRetention } : {}),
      ...(o.auditAnchors ? { anchorSink: o.auditAnchors } : {}),
    }),
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
    delegate: async (r, c, trace) =>
      r?.target?.remote
        ? remoteOrFail().delegate(r, c)
        : tasks.delegate(r, c, trace),
    getTask: async (id, c) =>
      isRemote(id)
        ? remoteOrFail().snapshot(await remoteOrFail().get(id, c))
        : tasks.getTask(id, c),
    listTasks: (q, c) => tasks.listTasks(q, c),
    listInstances: (c, ownerId) => instances.list(c, ownerId),
    drainInstance: (id, c) => instances.drain(id, c),
    async upgradeInstance(id, change, c) {
      await tasks.checkGrant(c);
      await enforcePolicy(o.pdp, {
        principal: c,
        action: 'agent:upgrade',
        resource: { type: 'agent-instance', id, tenantId: c?.tenantId },
      });
      return instances.upgrade(id, change, c, (tx, from, to) =>
        tasks.audit(tx, c, {
          type: 'instance.upgrade',
          action: 'agent:upgrade',
          resource: { type: 'agent-instance', id },
          decision: 'allow',
          details: { from: from.version, to: to.version, definition: to.id },
        }),
      );
    },
    async versionsInUse(definitionId, c) {
      if (c?.type !== 'service')
        throw new AgentropyError(
          'PermissionDenied',
          'Only trusted services can list version usage',
        );
      const usage = new Map<
        string,
        { instances: number; activeTasks: number }
      >();
      const bump = (v: string, k: 'instances' | 'activeTasks') => {
        const u = usage.get(v) ?? { instances: 0, activeTasks: 0 };
        u[k]++;
        usage.set(v, u);
      };
      await o.store.transaction(async (tx) => {
        for (const i of await tx.find<AgentInstance>('instances', {
          where: { tenantId: c.tenantId },
        }))
          if (
            i.value.definition.id === definitionId &&
            i.value.state !== 'retired'
          )
            bump(i.value.definition.version, 'instances');
        for (const t of await tx.find<TaskRecord>('tasks', {
          where: { tenantId: c.tenantId },
        }))
          if (
            t.value.snapshot.definition.id === definitionId &&
            !isTerminal(TASK_MACHINE, t.value.status)
          )
            bump(t.value.snapshot.definition.version, 'activeTasks');
      });
      return [...usage]
        .map(([version, u]) => ({ version, ...u }))
        .sort((a, b) => a.version.localeCompare(b.version));
    },
    shareInstance: (id, ids, c) => instances.share(id, ids, c),
    getTaskByIdempotencyKey: (k, c) => tasks.getTaskByIdempotencyKey(k, c),
    getResult: async <O>(id: string, c: TrustedPrincipal): Promise<O> => {
      if (!isRemote(id)) return tasks.getResult<O>(id, c);
      const r = await remoteOrFail().get(id, c);
      if (r.status === 'completed') return r.output as O;
      if (r.status === 'failed')
        throw new AgentropyError(
          'TaskFailed',
          r.outcome?.message ?? 'Remote task failed',
        );
      if (r.status === 'cancelled')
        throw new AgentropyError('TaskCancelled', 'Remote task cancelled');
      throw new AgentropyError('NotReady', 'Remote task has not finished');
    },
    cancel: (id, c, reason) =>
      isRemote(id) ? remoteOrFail().cancel(id, c) : tasks.cancel(id, c, reason),
    subscribe: (id, c, from, options) =>
      stream.subscribe(id, c, from, options?.signal),
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
      await store.transaction(async (tx) => {
        // Other workers' shared decision caches drop the grant's decisions on their next sync (FEAT-033.1).
        await recordPolicyInvalidation(
          tx,
          tasks.newId('invalidation'),
          { tenantId: caller.tenantId, grantRef },
          now(),
        );
        await tasks.audit(tx, caller, {
          type: 'authority.revoke',
          action: 'grant:revoke',
          // The reference itself stays out of the audit trail; its digest identifies it.
          resource: { type: 'grant', id: digestOf(grantRef) },
          decision: 'allow',
          details: { signalled: signalled.length, invalidatedDecisions },
        });
      });
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
    schedulerStatus: () => ({ ...scheduler }),
    start(intervalMs = 250, options = {}) {
      let stopped = false;
      let running: Promise<void> = Promise.resolve();
      scheduler.running = true;
      scheduler.startedAt = now();
      scheduler.intervalMs = intervalMs;
      scheduler.consecutiveFailures = 0;
      delete scheduler.lastError;
      // One tick never rejects: a failing store or a bug in one tick is reported and the next tick runs, instead of
      // the rejection poisoning the chain (every later tick skipped) and escaping as an unhandled rejection.
      const tick = async () => {
        try {
          await wakeups.poll();
          await runtime.tick();
          scheduler.lastTickAt = now();
          scheduler.consecutiveFailures = 0;
          delete scheduler.lastError;
        } catch (err) {
          const error = toAgentropyError(err);
          scheduler.consecutiveFailures++;
          scheduler.lastError = error.code;
          tasks.telemetry.count(METRICS.schedulerErrors, 1, {
            'agentropy.error.code': error.code,
          });
          try {
            options.onError?.(error);
          } catch {
            // A failing error hook must not take the loop down either.
          }
        }
      };
      const timer = setInterval(() => {
        if (stopped) return;
        running = running.then(tick);
      }, intervalMs);
      return async () => {
        stopped = true;
        clearInterval(timer);
        await running;
        await runtime.idle();
        scheduler.running = false;
      };
    },
  };
  return app;
}
