/**
 * TaskService (Agent v1 AgentService task operations, runtime contract §1): authoritative for local tasks.
 * Guard order: authenticate → authorize (grant, tenant, policy; invisible → NotFound) → schema →
 * idempotency replay → entity state → capability/guarantee → limits. Every transition is a CAS in the
 * Store and emits exactly one outbox event in the same transaction.
 */
import { createHash } from 'node:crypto';
import {
  AgentropyError,
  EXECUTION_MACHINE,
  TASK_MACHINE,
  assertTransition,
  digestOf,
  enforcePolicy,
  isTerminal,
  resolveAcceptance,
  validateAgainst,
  type AcceptanceEnvironment,
  type AcceptanceSnapshot,
  type AgentInvocation,
  type DelegationRequest,
  type ExecutionRecord,
  type PolicyDecisionPoint,
  type RetryPolicy,
  type Store,
  type StoreTx,
  type StoredDocument,
  type TaskHandle,
  type TaskSnapshot,
  type TaskStatus,
  type TrustedPrincipal,
  type VersionedRef,
  type WakeupRequest,
} from '@agentropy/core';
import type { DefinitionRegistry, InstanceDirectory } from './registry.js';

export interface TaskRecord {
  taskId: string;
  tenantId: string;
  status: TaskStatus;
  instanceId: string;
  ownerId: string;
  callerId: string;
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
}

export interface IdempotencyRecord {
  tenantId: string;
  taskId: string;
  fingerprint: string;
}

export interface GrantVerifier {
  /** Validates a delegated authority reference at a protected boundary (never cached across operations). */
  check(
    ref: string,
    tenantId: string,
  ): Promise<'valid' | 'expired' | 'revoked'>;
}

export type IdKind =
  'task' | 'execution' | 'event' | 'wakeup' | 'action' | 'entry';

export interface TaskServiceOptions {
  store: Store;
  definitions: DefinitionRegistry;
  instances: InstanceDirectory;
  acceptance: AcceptanceEnvironment;
  pdp: PolicyDecisionPoint;
  grants?: GrantVerifier;
  now: () => string;
  newId?: (kind: IdKind) => string;
  limits?: { maxDepth?: number; maxFanOut?: number };
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoff: { initialMs: 1000, maxMs: 300_000, multiplier: 2 },
};

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
  };
}

export class TaskService {
  private seq = 0;
  private readonly cancelHooks = new Set<(taskId: string) => void>();

  constructor(readonly o: TaskServiceOptions) {}

  newId(kind: IdKind): string {
    return this.o.newId ? this.o.newId(kind) : `${kind}-${++this.seq}`;
  }

  /** The runtime registers to hear cancel requests for running executions. */
  onCancelRequested(hook: (taskId: string) => void): void {
    this.cancelHooks.add(hook);
  }

  async delegate<I>(
    request: DelegationRequest<I>,
    caller: TrustedPrincipal,
  ): Promise<TaskHandle> {
    // 1. Authenticate.
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    // 2. Authorize: grant, target visibility (tenant), policy.
    await this.checkGrant(caller);
    const instance = await this.resolveTarget(request, caller);
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
    // 3. Schema.
    validateAgainst(
      definition.inputSchema,
      request.input,
      `${definition.id} input`,
    );
    // 4. Idempotency replay (before state: a retry always gets its original answer).
    const fingerprint = digestOf({
      target: { instanceId: instance.id },
      input: request.input,
      parentTaskId: request.parentTaskId ?? null,
    });
    const idemId = hashKey(caller.tenantId, caller.id, request.idempotencyKey);
    const replay = await this.o.store.transaction((tx) =>
      tx.get<IdempotencyRecord>('idempotency', idemId),
    );
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
    const task: TaskRecord = {
      taskId,
      tenantId: caller.tenantId,
      status: 'created',
      instanceId: instance.id,
      ownerId: instance.ownerId,
      callerId: caller.id,
      ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}),
      depth,
      definition: instance.definition,
      input: request.input,
      correlationId: request.correlationId,
      snapshot,
      retryPolicy: definition.retryPolicy ?? DEFAULT_RETRY,
      activation: 1,
      attempt: 1,
      ...(request.deadline ? { deadline: request.deadline } : {}),
      ...(caller.delegatedAuthorityRef
        ? { grantRef: caller.delegatedAuthorityRef }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.o.store.transaction(async (tx) => {
        await tx.insert<IdempotencyRecord>('idempotency', idemId, {
          tenantId: caller.tenantId,
          taskId,
          fingerprint,
        });
        assertTransition(TASK_MACHINE, null, 'created', 'T1');
        const created = await tx.insert('tasks', taskId, task);
        await this.emit(tx, task, created.revision);
        // T2: the instance is available, so bind it and queue the first execution in the same unit of work.
        await this.transition(tx, created, 'assigned', 'T2');
        await this.queueExecution(tx, taskId, 1, 1, 'delegation', now);
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
    return this.handleFor(taskId);
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
      if (t.status === 'running') {
        if (t.cancelRequestedAt) return cur;
        return tx.update('tasks', taskId, cur.revision, {
          ...t,
          cancelRequestedAt: this.o.now(),
          updatedAt: this.o.now(),
        });
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

  private async checkGrant(caller: TrustedPrincipal): Promise<void> {
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

  private async resolveTarget(
    request: DelegationRequest<unknown>,
    caller: TrustedPrincipal,
  ) {
    if (request.target.instanceId) {
      // AC-09: a target owned by another tenant is TenantMismatch; an unknown ID stays NotFound.
      const tenant = this.o.instances.tenantOf(request.target.instanceId);
      if (tenant !== undefined && tenant !== caller.tenantId) {
        throw new AgentropyError(
          'TenantMismatch',
          'Cross-tenant delegation denied',
        );
      }
      return this.o.instances.get(request.target.instanceId, caller);
    }
    if (request.target.definition) {
      return this.o.instances.create(
        {
          definition: request.target.definition,
          ownerId: caller.id,
          idempotencyKey: `auto:${request.idempotencyKey}`,
        },
        caller,
      );
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
    const t = doc.value;
    return {
      taskId,
      agentInstanceId: t.instanceId,
      // The status at acceptance: both T1 and T2 commit in the accepting transaction.
      status: 'assigned',
      definition: t.definition,
      durability: t.snapshot.durability,
    };
  }

  async emit(
    tx: StoreTx,
    t: TaskRecord,
    revision: number,
    type = 'taskStatusChanged',
  ): Promise<void> {
    const eventId = this.newId('event');
    await tx.insert('outbox', eventId, {
      eventId,
      type,
      aggregateId: t.taskId,
      tenantId: t.tenantId,
      revision,
      payload: {
        status: t.status,
        ...(t.outcome ? { outcome: t.outcome } : {}),
      },
      correlationId: t.correlationId,
      published: 0,
      at: this.o.now(),
    });
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
    return doc;
  }

  async queueExecution(
    tx: StoreTx,
    taskId: string,
    activation: number,
    attempt: number,
    trigger: AgentInvocation['trigger'],
    runAt: string,
  ): Promise<string> {
    assertTransition(EXECUTION_MACHINE, null, 'queued', 'E1');
    const executionId = this.newId('execution');
    await tx.insert<StoredExecution>('executions', executionId, {
      executionId,
      taskId,
      activation,
      attempt,
      trigger,
      state: 'queued',
      runAt,
    });
    return executionId;
  }
}
