/**
 * TaskService (Agent v1 AgentService task operations, runtime contract §1): authoritative for local tasks.
 * Guard order: authenticate → authorize (grant, tenant, policy; invisible → NotFound) → schema →
 * idempotency replay → entity state → capability/guarantee → limits. Every transition is a CAS in the
 * Store and emits exactly one outbox event in the same transaction.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  AgentropyError,
  isAgentropyError,
  EXECUTION_MACHINE,
  HUMAN_ACTION_MACHINE,
  INSTANCE_MACHINE,
  TASK_MACHINE,
  assertTransition,
  digestOf,
  enforcePolicy,
  isTerminal,
  normalizeInstant,
  resolveAcceptance,
  validateAgainst,
  type AcceptanceEnvironment,
  type AcceptanceSnapshot,
  type AgentInstance,
  type AgentInvocation,
  type AuditEvent,
  type ConversationTurn,
  type DelegationRequest,
  type ExecutionRecord,
  type PolicyDecisionPoint,
  type RetryPolicy,
  type Store,
  type StoreTx,
  type StoredDocument,
  type TaskEventType,
  type Telemetry,
  METRICS,
  NOOP_TELEMETRY,
  SPANS,
  sanitizeTraceparent,
  type TaskHandle,
  type TaskSnapshot,
  TRANSITION_EVENT,
  type TRANSITION_EVENT_TYPES,
  type TaskStatus,
  type TrustedPrincipal,
  type VersionedRef,
  type WakeupRequest,
} from '@agentropy/core';
import { recordAuditIntent } from './audit.js';
import { DEFAULT_LIMITS, assertMaxBytes } from './limits.js';
import { checkTaskQuota, type QuotaResolver } from './quotas.js';
import { pokeWakeups } from './wake-index.js';
import type { FaultHook } from './outbox.js';
import type { DefinitionRegistry, InstanceDirectory } from './registry.js';

export interface TaskRecord {
  taskId: string;
  tenantId: string;
  status: TaskStatus;
  instanceId: string;
  ownerId: string;
  callerId: string;
  /** Principal type of the delegating caller (dispatch-time policy checks use it). */
  callerType?: TrustedPrincipal['type'];
  /** Resource budget from the delegation request (cost units = model tokens for `reasoning`). */
  budget?: { maxCostUnits?: number; maxActivations?: number };
  /** Trace context of the accepting span (W3C traceparent); parent of every execution span of this task. */
  traceparent?: string;
  parentTaskId?: string;
  depth: number;
  definition: VersionedRef;
  input: unknown;
  correlationId: string;
  snapshot: AcceptanceSnapshot;
  retryPolicy: RetryPolicy;
  activation: number;
  attempt: number;
  deadline?: string;
  cancelRequestedAt?: string;
  waitingOn?: WakeupRequest;
  output?: unknown;
  outcome?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  /** The delegating caller's grant; the acting instance works under it and it is re-checked at protected effects. */
  grantRef?: string;
  /** Fencing token of the current lease. */
  leaseEpoch?: number;
}

export interface StoredExecution extends ExecutionRecord {
  /** Earliest time the pool may lease it (retry backoff). */
  runAt: string;
  leaseExpiresAt?: string;
  /** Tenant of the task, for fair dispatch and per-tenant concurrency across workers (M3-02). */
  tenantId?: string;
  /** Worker that holds (or last held) the lease. */
  workerId?: string;
}

export interface IdempotencyRecord {
  tenantId: string;
  taskId: string;
  fingerprint: string;
}

/** Outbox row: one TaskEvent plus delivery bookkeeping (messaging contract, R-29). */
export interface OutboxRecord {
  eventId: string;
  type: TaskEventType;
  aggregateId: string;
  tenantId: string;
  revision: number;
  sequence: number;
  status: TaskStatus;
  occurredAt: string;
  data?: unknown;
  /** Status and outcome at commit time (kept for consumers that predate TaskEvent). */
  payload: { status: TaskStatus; outcome?: { code: string; message: string } };
  correlationId: string;
  /** 0 until every relay consumer has accepted it. */
  published: 0 | 1;
  attempts: number;
  lastError?: string;
}

/** Users whose inbox shows a human-action request: its named assignees, else the task owner. */
export const actionUsers = (
  a: { assignees: { principalIds?: string[] } },
  task: { ownerId: string },
): string[] =>
  a.assignees.principalIds?.length ? a.assignees.principalIds : [task.ownerId];

/** ADR-0024 activation eligibility gate: scheduler metadata, never a task status (store doc revision = gateRevision). */
export interface DispatchGate {
  taskId: string;
  /** Task revision observed when the gate was written. */
  taskRevision: number;
  reason:
    | 'policy-indeterminate'
    | 'policy-denied'
    | 'authority-expired'
    | 'authority-revoked';
  /** Present while a bounded PDP retry is scheduled; null when reauthorization (or an operator) is required. */
  nextCheckAt: string | null;
  /** Grant to evaluate at the next check (set by reauthorization); applied to the task at lease time. */
  grantRef?: string;
  lastDecisionAt: string;
  /** Gate evaluations since the last reauthorization (not Execution.attempt). */
  attempt: number;
}

export interface GrantVerifier {
  /** Validates a delegated authority reference at a protected boundary (never cached across operations). */
  check(
    ref: string,
    tenantId: string,
  ): Promise<'valid' | 'expired' | 'revoked'>;
  /**
   * Optional (D-15): derive a grant no wider than `ref`, scoped to one target agent instance, for a child task.
   * Throwing denies the delegation.
   */
  narrow?(
    ref: string,
    scope: { tenantId: string; agentInstanceId: string; parentTaskId?: string },
  ): Promise<string>;
}

export type IdKind =
  | 'task'
  | 'execution'
  | 'event'
  | 'wakeup'
  | 'action'
  | 'entry'
  | 'audit'
  | 'invalidation';

export interface TaskServiceOptions {
  store: Store;
  definitions: DefinitionRegistry;
  instances: InstanceDirectory;
  acceptance: AcceptanceEnvironment;
  pdp: PolicyDecisionPoint;
  grants?: GrantVerifier;
  now: () => string;
  newId?: (kind: IdKind) => string;
  limits?: { maxDepth?: number; maxFanOut?: number; maxInputBytes?: number };
  /** Fault hook for audit-intent and recovery tests; production passes nothing. */
  faults?: FaultHook;
  /** Spans and metrics (observability contract); defaults to no-op. */
  telemetry?: Telemetry;
  /** Per-tenant quotas (M2-11), checked inside the accepting transaction. */
  quotas?: QuotaResolver;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoff: { initialMs: 1000, maxMs: 300_000, multiplier: 2 },
};

/** The handle an acceptance answers with. */
const handleOf = (t: TaskRecord): TaskHandle => ({
  taskId: t.taskId,
  agentInstanceId: t.instanceId,
  // The status at acceptance: both T1 and T2 commit in the accepting transaction.
  status: 'assigned',
  definition: t.definition,
  durability: t.snapshot.durability,
});

export const hashKey = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function toSnapshot(t: TaskRecord, revision: number): TaskSnapshot {
  return {
    taskId: t.taskId,
    status: t.status,
    revision,
    agentInstanceId: t.instanceId,
    ...(t.parentTaskId ? { parentTaskId: t.parentTaskId } : {}),
    ...(t.cancelRequestedAt ? { cancelRequestedAt: t.cancelRequestedAt } : {}),
    ...(t.waitingOn ? { waitingOn: t.waitingOn } : {}),
    ...(t.outcome ? { outcome: t.outcome } : {}),
    authority: 'local',
    correlationId: t.correlationId,
    updatedAt: t.updatedAt,
  };
}

export class TaskService {
  private readonly cancelHooks = new Set<(taskId: string) => void>();

  constructor(readonly o: TaskServiceOptions) {}

  newId(kind: IdKind): string {
    // IDs must stay unique across restarts of the same store.
    return this.o.newId ? this.o.newId(kind) : `${kind}-${randomUUID()}`;
  }

  /** The runtime registers to hear cancel requests for running executions. */
  onCancelRequested(hook: (taskId: string) => void): void {
    this.cancelHooks.add(hook);
  }

  get telemetry(): Telemetry {
    return this.o.telemetry ?? NOOP_TELEMETRY;
  }

  /**
   * Accept a task (see `accept`) inside an `agentropy.task.accept` span. `trace.traceparent` is an untrusted
   * correlation hint from ingress or the parent capability span: it is sanitized and never used for authorization.
   */
  async delegate<I>(
    request: DelegationRequest<I>,
    caller: TrustedPrincipal,
    trace: { traceparent?: string } = {},
  ): Promise<TaskHandle> {
    const parent = sanitizeTraceparent(trace.traceparent);
    if (trace.traceparent !== undefined && !parent)
      this.telemetry.count(METRICS.traceRejected, 1, { carrier: 'delegate' });
    const span = this.telemetry.startSpan(SPANS.accept, {
      kind: 'server',
      ...(parent ? { parent } : {}),
      attributes: {
        'agentropy.tenant.id': caller?.tenantId ?? '',
        'agentropy.correlation_id': request?.correlationId ?? '',
        ...(request?.target && 'instanceId' in request.target
          ? { 'agentropy.instance.id': request.target.instanceId }
          : {}),
      },
    });
    try {
      const handle = await this.accept(
        request,
        caller,
        span.traceparent ?? parent,
      );
      span.setAttributes({ 'agentropy.task.id': handle.taskId });
      return handle;
    } catch (err) {
      span.fail((err as { code?: string }).code ?? 'Internal');
      throw err;
    } finally {
      span.end();
    }
  }

  private async accept<I>(
    request: DelegationRequest<I>,
    caller: TrustedPrincipal,
    traceparent: string | undefined,
  ): Promise<TaskHandle> {
    // 1. Authenticate.
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    // 2. Authorize: grant, target visibility (tenant), policy.
    await this.checkGrant(caller);
    const idemId = hashKey(caller.tenantId, caller.id, request.idempotencyKey);
    // FEAT-032.2: the target and the idempotency record come from one read; the record is acted on only below.
    const { instance, replay: early } = await this.resolveTarget(
      request,
      caller,
      idemId,
    );
    await enforcePolicy(this.o.pdp, {
      principal: caller,
      action: 'delegation:delegate',
      resource: {
        type: 'agent-instance',
        id: instance.id,
        tenantId: caller.tenantId,
      },
    });
    const definition = this.o.definitions.require(instance.definition);
    // 3. Schema, and the size bound (a payload cannot grow task rows without limit).
    validateAgainst(
      definition.inputSchema,
      request.input,
      `${definition.id} input`,
    );
    assertMaxBytes(
      request.input,
      this.o.limits?.maxInputBytes ?? DEFAULT_LIMITS.maxInputBytes,
      'input',
    );
    // The deadline is compared as a string by the scheduler: keep only UTC ISO-8601 (FEAT-038.3).
    const deadline =
      request.deadline === undefined
        ? undefined
        : normalizeInstant(request.deadline, 'deadline');
    // 4. Idempotency replay (before state: a retry always gets its original answer).
    const fingerprint = digestOf({
      target: { instanceId: instance.id },
      input: request.input,
      parentTaskId: request.parentTaskId ?? null,
    });
    const replay =
      early === null
        ? await this.o.store.transaction((tx) =>
            tx.get<IdempotencyRecord>('idempotency', idemId),
          )
        : early;
    if (replay) {
      if (replay.value.fingerprint !== fingerprint)
        throw new AgentropyError(
          'IdempotencyConflict',
          'Idempotency key reused with a different request',
        );
      return this.handleFor(replay.value.taskId);
    }
    // 5. Entity state.
    if (instance.state === 'suspended')
      throw new AgentropyError(
        'InstanceUnavailable',
        'Target instance is suspended',
      );
    if (instance.state === 'retired')
      throw new AgentropyError('InvalidState', 'Target instance is retired', {
        details: { kind: 'instance' },
      });
    if (instance.draining)
      throw new AgentropyError(
        'InstanceUnavailable',
        'Target instance is draining and accepts no new tasks',
        { details: { reason: 'draining' } },
      );
    // 6. Capability, guarantee and implementation resolution → pinned snapshot.
    const snapshot = await resolveAcceptance(
      { definition, principal: caller, tenantId: caller.tenantId },
      this.o.acceptance,
    );
    // 7. Limits.
    const parent = request.parentTaskId
      ? await this.o.store.transaction((tx) =>
          tx.get<TaskRecord>('tasks', request.parentTaskId!),
        )
      : undefined;
    if (
      request.parentTaskId &&
      (!parent || parent.value.tenantId !== caller.tenantId)
    )
      throw new AgentropyError('NotFound', 'Parent task not found');
    const depth = parent ? parent.value.depth + 1 : 0;
    if (depth > (this.o.limits?.maxDepth ?? 5))
      throw new AgentropyError(
        'DelegationDepthExceeded',
        'Delegation depth exceeded',
        { details: { depth } },
      );
    if (parent) {
      const children = await this.o.store.transaction((tx) =>
        tx.find('tasks', { where: { parentTaskId: parent.id } }),
      );
      if (children.length >= (this.o.limits?.maxFanOut ?? 20))
        throw new AgentropyError(
          'FanOutExceeded',
          'Delegation fan-out exceeded',
          { details: { children: children.length } },
        );
    }

    const now = this.o.now();
    const taskId = this.newId('task');
    // D-15: an agent delegating on someone's behalf passes on a grant narrowed to the target, when the grant
    // service supports narrowing; a refused narrowing is a denial, never a silent fallback to the wider grant.
    let grantRef = caller.delegatedAuthorityRef;
    if (grantRef && caller.type === 'agent' && this.o.grants?.narrow) {
      try {
        grantRef = await this.o.grants.narrow(grantRef, {
          tenantId: caller.tenantId,
          agentInstanceId: instance.id,
          ...(request.parentTaskId
            ? { parentTaskId: request.parentTaskId }
            : {}),
        });
      } catch (cause) {
        if (isAgentropyError(cause)) throw cause;
        throw new AgentropyError(
          'PermissionDenied',
          'Delegated authority cannot be narrowed to the target',
          { cause },
        );
      }
    }
    const task: TaskRecord = {
      taskId,
      tenantId: caller.tenantId,
      status: 'created',
      instanceId: instance.id,
      ownerId: instance.ownerId,
      callerId: caller.id,
      callerType: caller.type,
      ...(traceparent ? { traceparent } : {}),
      ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}),
      depth,
      definition: instance.definition,
      input: request.input,
      correlationId: request.correlationId,
      snapshot,
      retryPolicy: definition.retryPolicy ?? DEFAULT_RETRY,
      activation: 1,
      attempt: 1,
      ...(deadline ? { deadline } : {}),
      ...(grantRef ? { grantRef } : {}),
      ...(request.budget ? { budget: request.budget } : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.o.store.transaction(async (tx) => {
        await checkTaskQuota(
          tx,
          caller.tenantId,
          this.o.quotas?.(caller.tenantId),
          now,
        );
        // Fence against a concurrent suspend, drain or retire between the checks above and this commit.
        const live = await tx.get<AgentInstance>('instances', instance.id);
        if (!live || live.value.state !== 'available' || live.value.draining)
          throw new AgentropyError(
            'InstanceUnavailable',
            'Target instance changed state during acceptance',
            {
              details: {
                reason: live?.value.draining
                  ? 'draining'
                  : (live?.value.state ?? 'missing'),
              },
            },
          );
        await tx.insert<IdempotencyRecord>('idempotency', idemId, {
          tenantId: caller.tenantId,
          taskId,
          fingerprint,
        });
        assertTransition(TASK_MACHINE, null, 'created', 'T1');
        const created = await tx.insert('tasks', taskId, task);
        await this.audit(tx, caller, {
          type: 'task.accept',
          action: 'delegation:delegate',
          resource: { type: 'task', id: taskId },
          decision: 'allow',
          correlationId: task.correlationId,
          taskId,
          // Audit chain (D-15): who delegated, on whose behalf, and whether authority was narrowed.
          details: {
            callerType: caller.type,
            ...(request.parentTaskId
              ? { parentTaskId: request.parentTaskId }
              : {}),
            ...(caller.delegatedAuthorityRef
              ? { narrowed: grantRef !== caller.delegatedAuthorityRef }
              : {}),
          },
        });
        await this.emit(tx, task, created.revision);
        // T2: the instance is available, so bind it and queue the first execution in the same unit of work.
        await this.transition(tx, created, 'assigned', 'T2');
        await this.queueExecution(
          tx,
          taskId,
          1,
          1,
          'delegation',
          now,
          caller.tenantId,
        );
      });
    } catch (err) {
      // A concurrent duplicate won the idempotency insert: answer with its task.
      const winner = await this.o.store.transaction((tx) =>
        tx.get<IdempotencyRecord>('idempotency', idemId),
      );
      if (winner && winner.value.fingerprint === fingerprint)
        return this.handleFor(winner.value.taskId);
      throw err;
    }
    this.telemetry.count(METRICS.tasksAccepted, 1, {
      'agentropy.agent.id': definition.id,
      'agentropy.profile': definition.profile.id,
    });
    return handleOf(task);
  }

  /**
   * One user message → one turn task on the caller's own conversational instance (Agent v1 "Conversation
   * turn model"). The turn handler reads `conversation.briefing` and replies; it does not wait for children.
   */
  async submitTurn(
    turn: ConversationTurn,
    caller: TrustedPrincipal,
  ): Promise<TaskHandle> {
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    const instance = await this.o.instances.get(turn.instanceId, caller);
    if (instance.ownerId !== caller.id)
      throw new AgentropyError('NotFound', 'Conversational instance not found');
    const definition = this.o.definitions.require(instance.definition);
    if (definition.profile.id !== 'conversational')
      throw new AgentropyError(
        'UnsupportedOperation',
        'Turns are only accepted by conversational agents',
        { details: { profile: definition.profile.id } },
      );
    return this.delegate(
      {
        target: { instanceId: instance.id },
        input: { sessionId: turn.sessionId, text: turn.text },
        idempotencyKey: `turn:${turn.idempotencyKey}`,
        correlationId: turn.correlationId ?? randomUUID(),
      },
      caller,
    );
  }

  /**
   * Owner visibility (R-13, M2-05): tasks the caller delegated or owns (a trusted service sees its tenant),
   * newest last, with an opaque cursor. Other users' and tenants' tasks are never listed.
   */
  async listTasks(
    query: {
      instanceId?: string;
      status?: TaskStatus[];
      cursor?: string;
      limit?: number;
    },
    caller: TrustedPrincipal,
  ): Promise<{ tasks: TaskSnapshot[]; cursor: string }> {
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    const start = query.cursor ? Number(query.cursor) : 0;
    if (!Number.isSafeInteger(start) || start < 0)
      throw new AgentropyError('SchemaViolation', 'Invalid task cursor');
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    // Read through the indexes: a trusted service sees the tenant; anyone else the tasks they delegated (callerId)
    // or own (ownerId). Each source is read in pages of `limit`, so the work follows the page, not the history.
    const base = {
      tenantId: caller.tenantId,
      ...(query.instanceId ? { instanceId: query.instanceId } : {}),
    };
    const sources =
      caller.type === 'service'
        ? [base]
        : [
            { ...base, callerId: caller.id },
            { ...base, ownerId: caller.id },
          ];
    const page: StoredDocument<TaskRecord>[] = [];
    let after = start;
    while (page.length < limit) {
      const { rows, exhausted } = await this.o.store.transaction(async (tx) => {
        const merged = new Map<string, StoredDocument<TaskRecord>>();
        let full = false;
        for (const where of sources) {
          const r = await tx.find<TaskRecord>('tasks', {
            where,
            orderBy: 'seq',
            afterSeq: after,
            limit,
          });
          if (r.length === limit) full = true;
          for (const d of r) merged.set(d.id, d);
        }
        const sorted = [...merged.values()].sort((a, b) => a.seq - b.seq);
        // When a source filled its page, only the first `limit` rows of the union are known to be complete.
        return {
          rows: full ? sorted.slice(0, limit) : sorted,
          exhausted: !full,
        };
      });
      for (const d of rows) {
        after = d.seq;
        if (!query.status?.length || query.status.includes(d.value.status))
          page.push(d);
        if (page.length === limit) break;
      }
      if (exhausted) break;
    }
    return {
      tasks: page.map((d) => toSnapshot(d.value, d.revision)),
      cursor: String(after),
    };
  }

  async getTask(
    taskId: string,
    caller: TrustedPrincipal,
  ): Promise<TaskSnapshot> {
    const doc = await this.visible(taskId, caller);
    return toSnapshot(doc.value, doc.revision);
  }

  async getTaskByIdempotencyKey(
    key: string,
    caller: TrustedPrincipal,
  ): Promise<TaskSnapshot> {
    const rec = await this.o.store.transaction((tx) =>
      tx.get<IdempotencyRecord>(
        'idempotency',
        hashKey(caller.tenantId, caller.id, key),
      ),
    );
    if (!rec) throw new AgentropyError('NotFound', 'Task not found');
    return this.getTask(rec.value.taskId, caller);
  }

  async getResult<O>(taskId: string, caller: TrustedPrincipal): Promise<O> {
    const { value: t } = await this.visible(taskId, caller);
    if (t.status === 'completed') return t.output as O;
    if (t.status === 'failed')
      throw new AgentropyError('TaskFailed', 'Task failed', {
        details: { ...t.outcome },
      });
    if (t.status === 'cancelled')
      throw new AgentropyError('TaskCancelled', 'Task cancelled', {
        details: { ...t.outcome },
      });
    throw new AgentropyError('NotReady', 'Task has not completed');
  }

  async cancel(
    taskId: string,
    caller: TrustedPrincipal,
    reason = 'cancelled',
  ): Promise<TaskSnapshot> {
    await this.checkGrant(caller);
    const doc = await this.visible(taskId, caller);
    await enforcePolicy(this.o.pdp, {
      principal: caller,
      action: 'delegation:cancel',
      resource: { type: 'task', id: taskId, tenantId: caller.tenantId },
    });
    const result = await this.o.store.transaction(async (tx) => {
      const cur = (await tx.get<TaskRecord>('tasks', taskId))!;
      const t = cur.value;
      if (isTerminal(TASK_MACHINE, t.status))
        throw new AgentropyError('InvalidState', `Task is ${t.status}`);
      await this.audit(tx, caller, {
        type: 'task.cancel',
        action: 'delegation:cancel',
        resource: { type: 'task', id: taskId },
        decision: 'allow',
        correlationId: t.correlationId,
        taskId,
      });
      if (t.status === 'running') {
        if (t.cancelRequestedAt) return cur;
        const next = {
          ...t,
          cancelRequestedAt: this.o.now(),
          updatedAt: this.o.now(),
        };
        const doc = await tx.update('tasks', taskId, cur.revision, next);
        await this.emit(tx, next, doc.revision, 'taskCancelRequested', {
          reason,
        });
        return doc;
      }
      return this.terminate(tx, cur, 'cancelled', 'T10', {
        code: 'Cancelled',
        message: reason,
      });
    });
    if (result.value.status === 'running')
      for (const hook of this.cancelHooks) hook(taskId);
    void doc;
    return toSnapshot(result.value, result.revision);
  }

  // --- internal helpers shared with the runtime -------------------------------------------------

  async visible(
    taskId: string,
    caller: TrustedPrincipal,
  ): Promise<StoredDocument<TaskRecord>> {
    if (!caller?.id)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    const doc = await this.o.store.transaction((tx) =>
      tx.get<TaskRecord>('tasks', taskId),
    );
    // Authorization before state: an invisible task is NotFound, whatever its state (AC-04).
    const t = doc?.value;
    if (
      !doc ||
      !t ||
      t.tenantId !== caller.tenantId ||
      !(
        t.callerId === caller.id ||
        t.ownerId === caller.id ||
        caller.type === 'service'
      )
    ) {
      throw new AgentropyError('NotFound', 'Task not found');
    }
    return doc;
  }

  async checkGrant(caller: TrustedPrincipal): Promise<void> {
    if (!caller.delegatedAuthorityRef || !this.o.grants) return;
    const status = await this.o.grants
      .check(caller.delegatedAuthorityRef, caller.tenantId)
      .catch(() => {
        throw new AgentropyError(
          'PolicyDecisionUnavailable',
          'Grant status unavailable',
        );
      });
    if (status !== 'valid')
      throw new AgentropyError(
        'AuthorityExpired',
        `Delegated authority ${status}`,
        { details: { status } },
      );
  }

  /**
   * D-08 delegation governance: an instance accepts work from its owner, principals the owner shared it with,
   * agents whose own instance has the same owner (or a shared one), and trusted services. Everyone else in the
   * tenant gets NotFound, so instance IDs do not reveal other users' agents. Policy (PDP) still applies after this.
   */
  private async checkInstanceAccess(
    target: AgentInstance,
    caller: TrustedPrincipal,
  ): Promise<void> {
    if (caller.type === 'service' || caller.id === target.ownerId) return;
    const shared = target.sharedWith ?? [];
    if (shared.includes(caller.id)) return;
    if (caller.type === 'agent') {
      const own = await this.o.store.transaction((tx) =>
        tx.get<AgentInstance>('instances', caller.id),
      );
      const owner = own?.value.ownerId;
      if (owner && (owner === target.ownerId || shared.includes(owner))) return;
    }
    throw new AgentropyError('NotFound', 'Instance not found', {
      details: { kind: 'instance' },
    });
  }

  /**
   * The visible target instance, and the caller's idempotency record when it could be read in the same
   * transaction (`null` when it was not read).
   */
  private async resolveTarget(
    request: DelegationRequest<unknown>,
    caller: TrustedPrincipal,
    idemId: string,
  ): Promise<{
    instance: AgentInstance;
    replay: StoredDocument<IdempotencyRecord> | undefined | null;
  }> {
    const instanceId = request.target.instanceId;
    if (instanceId) {
      const [doc, replay] = await this.o.store.transaction(
        async (tx) =>
          [
            await tx.get<AgentInstance>('instances', instanceId),
            await tx.get<IdempotencyRecord>('idempotency', idemId),
          ] as const,
      );
      // AC-09: a target owned by another tenant is TenantMismatch; an unknown ID stays NotFound.
      if (doc && doc.value.tenantId !== caller.tenantId)
        throw new AgentropyError(
          'TenantMismatch',
          'Cross-tenant delegation denied',
        );
      if (!doc)
        throw new AgentropyError('NotFound', 'Instance not found', {
          details: { kind: 'instance' },
        });
      await this.checkInstanceAccess(doc.value, caller);
      return { instance: doc.value, replay };
    }
    if (request.target.definition) {
      const instance = await this.o.instances.create(
        {
          definition: request.target.definition,
          ownerId: caller.id,
          idempotencyKey: `auto:${request.idempotencyKey}`,
        },
        caller,
      );
      return { instance, replay: null };
    }
    throw new AgentropyError(
      'SchemaViolation',
      'Delegation target needs an instanceId or a definition',
    );
  }

  private async handleFor(taskId: string): Promise<TaskHandle> {
    const doc = (await this.o.store.transaction((tx) =>
      tx.get<TaskRecord>('tasks', taskId),
    ))!;
    return handleOf(doc.value);
  }

  /** Mandatory audit intent in the caller's transaction (SEC-03); failure aborts it with AuditCommitUnavailable. */
  async audit(
    tx: StoreTx,
    principal: { id: string; tenantId: string },
    event: Omit<AuditEvent, 'at' | 'tenantId' | 'principalId'>,
  ): Promise<void> {
    await recordAuditIntent(
      tx,
      this.newId('audit'),
      {
        ...event,
        tenantId: principal.tenantId,
        principalId: principal.id,
        at: this.o.now(),
      },
      this.o.faults,
    );
  }

  /**
   * ADR-0024: a trusted principal re-establishes authority for a task held by the dispatch gate. Nothing is
   * dispatched here; the next scheduler pass re-evaluates the gate with a fresh policy decision and the new grant.
   */
  async reauthorize(taskId: string, caller: TrustedPrincipal): Promise<void> {
    await this.visible(taskId, caller);
    await this.checkGrant(caller);
    await enforcePolicy(this.o.pdp, {
      principal: caller,
      action: 'delegation:reauthorize',
      resource: { type: 'task', id: taskId, tenantId: caller.tenantId },
    });
    await this.o.store.transaction(async (tx) => {
      const task = (await tx.get<TaskRecord>('tasks', taskId))!;
      const gate = await tx.get<DispatchGate>('gates', taskId);
      if (!gate || isTerminal(TASK_MACHINE, task.value.status))
        throw new AgentropyError(
          'InvalidState',
          'Task is not held by the dispatch gate',
          {
            details: { kind: 'gate' },
          },
        );
      const grantRef = caller.delegatedAuthorityRef ?? gate.value.grantRef;
      await tx.update<DispatchGate>('gates', gate.id, gate.revision, {
        ...gate.value,
        nextCheckAt: this.o.now(),
        attempt: 0,
        ...(grantRef ? { grantRef } : {}),
      });
      await this.audit(tx, caller, {
        type: 'task.reauthorize',
        action: 'delegation:reauthorize',
        resource: { type: 'task', id: taskId },
        decision: 'allow',
        correlationId: task.value.correlationId,
        taskId,
      });
    });
  }

  /**
   * Append one TaskEvent to the outbox in the caller's transaction. Without `type` it is the transition
   * event for the status the task just entered (sequence 0); otherwise a non-transition event at the
   * current revision with the next sequence number.
   */
  async emit(
    tx: StoreTx,
    t: TaskRecord,
    revision: number,
    type?: Exclude<TaskEventType, (typeof TRANSITION_EVENT_TYPES)[number]>,
    data?: unknown,
  ): Promise<OutboxRecord> {
    let sequence = 0;
    if (type) {
      const atRevision = await tx.find<OutboxRecord>('outbox', {
        where: { aggregateId: t.taskId },
      });
      sequence = Math.max(
        1,
        atRevision.filter((e) => e.value.revision === revision).length,
      );
    }
    const eventId = this.newId('event');
    const record: OutboxRecord = {
      eventId,
      type: type ?? TRANSITION_EVENT[t.status],
      aggregateId: t.taskId,
      tenantId: t.tenantId,
      revision,
      sequence,
      status: t.status,
      occurredAt: this.o.now(),
      ...(data !== undefined ? { data } : {}),
      payload: {
        status: t.status,
        ...(t.outcome ? { outcome: t.outcome } : {}),
      },
      correlationId: t.correlationId,
      published: 0,
      attempts: 0,
    };
    await tx.insert<OutboxRecord>('outbox', eventId, record);
    return record;
  }

  async transition(
    tx: StoreTx,
    cur: StoredDocument<TaskRecord>,
    to: TaskStatus,
    edge: string,
    patch: Partial<TaskRecord> = {},
  ): Promise<StoredDocument<TaskRecord>> {
    assertTransition(TASK_MACHINE, cur.value.status, to, edge);
    const next: TaskRecord = {
      ...cur.value,
      ...patch,
      status: to,
      updatedAt: this.o.now(),
    };
    const doc = await tx.update('tasks', cur.id, cur.revision, next);
    await this.emit(tx, next, doc.revision);
    return doc;
  }

  /** Terminal transition: aborts queued/leased executions (E7) and revokes wake-ups and subscriptions. */
  async terminate(
    tx: StoreTx,
    cur: StoredDocument<TaskRecord>,
    to: 'failed' | 'cancelled' | 'completed',
    edge: string,
    outcome?: { code: string; message: string },
    output?: unknown,
  ): Promise<StoredDocument<TaskRecord>> {
    const { waitingOn: _waiting, ...rest } = cur.value;
    void _waiting;
    const doc = await this.transition(
      tx,
      { ...cur, value: rest as TaskRecord },
      to,
      edge,
      {
        ...(outcome ? { outcome } : {}),
        ...(output !== undefined ? { output } : {}),
      },
    );
    for (const e of await tx.find<StoredExecution>('executions', {
      where: { taskId: cur.id },
    })) {
      if (e.value.state === 'queued' || e.value.state === 'leased') {
        assertTransition(EXECUTION_MACHINE, e.value.state, 'aborted', 'E7');
        await tx.update('executions', e.id, e.revision, {
          ...e.value,
          state: 'aborted',
          endedAt: this.o.now(),
        });
      }
    }
    // A parent waiting on this child checks its wake-up on the next poll (FEAT-033.2).
    if (cur.value.parentTaskId)
      await pokeWakeups(tx, cur.value.parentTaskId, this.o.now());
    for (const w of await tx.find<{ status: string }>('wakeups', {
      where: { taskId: cur.id, status: 'armed' },
    })) {
      await tx.update('wakeups', w.id, w.revision, {
        ...w.value,
        status: 'revoked',
      });
    }
    for (const s of await tx.find<{ status: string }>('subscriptions', {
      where: { taskId: cur.id, status: 'active' },
    })) {
      await tx.update('subscriptions', s.id, s.revision, {
        ...s.value,
        status: 'revoked',
      });
    }
    const gate = await tx.get('gates', cur.id);
    if (gate) await tx.remove('gates', gate.id, gate.revision);
    // A draining instance retires when its last non-terminal task ends.
    const inst = await tx.get<AgentInstance>('instances', cur.value.instanceId);
    if (inst?.value.draining && inst.value.state !== 'retired') {
      const others = await tx.find<TaskRecord>('tasks', {
        where: { instanceId: cur.value.instanceId },
      });
      if (
        others.every(
          (o) => o.id === cur.id || isTerminal(TASK_MACHINE, o.value.status),
        )
      ) {
        assertTransition(INSTANCE_MACHINE, inst.value.state, 'retired');
        await tx.update<AgentInstance>('instances', inst.id, inst.revision, {
          ...inst.value,
          state: 'retired',
          revision: inst.value.revision + 1,
        });
      }
    }
    // Open human-action requests of a finished task can no longer be decided (H-revoke).
    for (const a of await tx.find<{
      status: string;
      requestId: string;
      assignees: { principalIds?: string[] };
    }>('humanActions', { where: { taskId: cur.id } })) {
      if (a.value.status !== 'pending' && a.value.status !== 'claimed')
        continue;
      assertTransition(
        HUMAN_ACTION_MACHINE,
        a.value.status as 'pending' | 'claimed',
        'revoked',
        'H-revoke',
      );
      const revoked = await tx.update('humanActions', a.id, a.revision, {
        ...a.value,
        status: 'revoked',
      });
      await this.emit(tx, doc.value, doc.revision, 'humanActionResolved', {
        requestId: a.value.requestId,
        revision: revoked.revision,
        outcome: 'revoked',
        assignees: actionUsers(a.value, doc.value),
      });
    }
    return doc;
  }

  async queueExecution(
    tx: StoreTx,
    taskId: string,
    activation: number,
    attempt: number,
    trigger: AgentInvocation['trigger'],
    runAt: string,
    /** The task's tenant when the caller already holds it; otherwise it is read. */
    knownTenantId?: string,
  ): Promise<string> {
    assertTransition(EXECUTION_MACHINE, null, 'queued', 'E1');
    const executionId = this.newId('execution');
    const tenantId =
      knownTenantId ??
      (await tx.get<TaskRecord>('tasks', taskId))?.value.tenantId;
    await tx.insert<StoredExecution>('executions', executionId, {
      executionId,
      taskId,
      ...(tenantId ? { tenantId } : {}),
      activation,
      attempt,
      trigger,
      state: 'queued',
      runAt,
    });
    return executionId;
  }
}
