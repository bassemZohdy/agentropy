/**
 * Remote delegation (FEAT-027.9, Communication v1 "Only for remote targets … call the router"): a delegation whose
 * target is `{ remote: { endpoint, definitionId } }` goes through the CommunicationRouter to the selected provider
 * (A2A, a custom broker provider, …). Locally the runtime keeps a *projection* of the remote task — the remote side
 * stays authoritative — and refreshes it on every scheduler poll, so a parent waiting on `child-tasks` wakes when
 * the remote task finishes.
 *
 * Checks before anything leaves the process: authentication, delegated-authority status, the same
 * `delegation:delegate` policy action as local delegation (resource type `remote-agent`), and route selection
 * (tenant boundary, required guarantees). The remote call is idempotent by the delegation's idempotency key, so a
 * crash between the remote acceptance and the local projection write is repaired by retrying the same step.
 */
import {
  AgentropyError,
  enforcePolicy,
  isTerminal,
  TASK_MACHINE,
  type CallContext,
  type CommunicationRouter,
  type DelegationRequest,
  type RemoteTaskRef,
  type RouteBinding,
  type TaskHandle,
  type TaskSnapshot,
  type TrustedPrincipal,
} from '@agentropy/core';
import { hashKey, type TaskService } from './task-service.js';

export interface RemoteTaskRecord {
  taskId: string;
  tenantId: string;
  callerId: string;
  callerType: TrustedPrincipal['type'];
  parentTaskId?: string;
  correlationId: string;
  idempotencyKey: string;
  fingerprint: string;
  definition: { id: string; version: string };
  route: RouteBinding;
  remoteTaskId: string;
  status: TaskSnapshot['status'];
  remoteState: string;
  /** Local projection revision: bumps whenever the observed remote state changes. */
  revision: number;
  output?: unknown;
  outcome?: { code: string; message: string };
  observedAt: string;
  createdAt: string;
  lastError?: string;
}

type RemoteTarget = NonNullable<DelegationRequest['target']['remote']>;

export class RemoteDelegationService {
  constructor(
    private readonly o: { tasks: TaskService; router: CommunicationRouter },
  ) {}

  private get store() {
    return this.o.tasks.o.store;
  }
  private now() {
    return this.o.tasks.o.now();
  }

  async delegate(
    request: DelegationRequest,
    caller: TrustedPrincipal,
  ): Promise<TaskHandle> {
    if (!caller?.id || !caller.tenantId)
      throw new AgentropyError('Unauthenticated', 'No trusted principal');
    const remote = request.target.remote as RemoteTarget | undefined;
    if (
      !remote ||
      typeof remote.endpoint !== 'string' ||
      !remote.endpoint ||
      typeof remote.definitionId !== 'string'
    )
      throw new AgentropyError(
        'SchemaViolation',
        'target.remote needs endpoint and definitionId',
      );
    if (!request.idempotencyKey)
      throw new AgentropyError('SchemaViolation', 'idempotencyKey required');
    await this.o.tasks.checkGrant(caller);

    const docId = `remote:${hashKey(caller.tenantId, caller.id, request.idempotencyKey)}`;
    const fingerprint = hashKey(
      JSON.stringify([remote, request.input ?? null]),
    );
    const existing = await this.store.transaction((tx) =>
      tx.get<RemoteTaskRecord>('remoteTasks', docId),
    );
    if (existing) return this.replay(existing.value, fingerprint);

    await enforcePolicy(this.o.tasks.o.pdp, {
      principal: caller,
      action: 'delegation:delegate',
      resource: {
        type: 'remote-agent',
        id: remote.endpoint,
        tenantId: caller.tenantId,
      },
    });
    const ctx: CallContext = {
      caller,
      correlationId: request.correlationId,
      ...(request.deadline ? { deadline: request.deadline } : {}),
    };
    const route = await this.o.router.selectRoute(
      {
        definitionId: remote.definitionId,
        ...(remote.version ? { version: remote.version } : {}),
        tenantId: caller.tenantId,
        endpoint: remote.endpoint,
      },
      'delegate',
      ctx,
    );
    // Never forward local authority: the provider authenticates as this runtime.
    const { delegatedAuthorityRef: _g, ...withoutGrant } = caller;
    void _g;
    const ref = await this.o.router.provider(route).delegate(
      route,
      {
        target: {},
        input: request.input,
        idempotencyKey: request.idempotencyKey,
        correlationId: request.correlationId,
        ...(request.deadline ? { deadline: request.deadline } : {}),
      },
      { ...ctx, caller: withoutGrant },
    );
    const now = this.now();
    const record: RemoteTaskRecord = {
      taskId: ref.localTaskId,
      tenantId: caller.tenantId,
      callerId: caller.id,
      callerType: caller.type,
      ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}),
      correlationId: request.correlationId,
      idempotencyKey: request.idempotencyKey,
      fingerprint,
      definition: {
        id: remote.definitionId,
        version: remote.version ?? 'remote',
      },
      route,
      remoteTaskId: ref.remoteTaskId,
      status: 'created',
      remoteState: 'accepted',
      revision: 1,
      observedAt: now,
      createdAt: now,
    };
    const stored = await this.store.transaction(async (tx) => {
      const raced = await tx.get<RemoteTaskRecord>('remoteTasks', docId);
      if (raced) return raced.value;
      await tx.insert<RemoteTaskRecord>('remoteTasks', docId, record);
      await this.o.tasks.audit(tx, caller, {
        type: 'task.delegate.remote',
        action: 'delegation:delegate',
        resource: { type: 'remote-agent', id: remote.endpoint },
        decision: 'allow',
        correlationId: request.correlationId,
        taskId: record.taskId,
        details: {
          provider: route.providerId,
          protocol: route.protocol,
          ...(request.parentTaskId
            ? { parentTaskId: request.parentTaskId }
            : {}),
        },
      });
      return record;
    });
    return this.handle(stored);
  }

  private replay(r: RemoteTaskRecord, fingerprint: string): TaskHandle {
    if (r.fingerprint !== fingerprint)
      throw new AgentropyError(
        'IdempotencyConflict',
        'Idempotency key reused with a different request',
      );
    return this.handle(r);
  }

  private handle(r: RemoteTaskRecord): TaskHandle {
    return {
      taskId: r.taskId,
      agentInstanceId: r.route.target.endpoint ?? r.definition.id,
      status: 'created',
      definition: r.definition,
      // The remote side decides durability; Agentropy promises nothing beyond its own projection.
      durability: 'none',
    };
  }

  private async find(taskId: string) {
    const rows = await this.store.transaction((tx) =>
      tx.find<RemoteTaskRecord>('remoteTasks', { where: {} }),
    );
    return rows.find((r) => r.value.taskId === taskId);
  }

  /**
   * The projection, visible to its delegator, to whoever can see the parent task (owner or delegator of the
   * parent), and to trusted services of the tenant — the same visibility a local child task has.
   */
  async get(
    taskId: string,
    caller: TrustedPrincipal,
  ): Promise<RemoteTaskRecord> {
    const doc = await this.find(taskId);
    const r = doc?.value;
    if (!r || r.tenantId !== caller?.tenantId)
      throw new AgentropyError('NotFound', 'Task not found');
    if (r.callerId === caller.id || caller.type === 'service') return r;
    if (r.parentTaskId) {
      const parent = await this.store.transaction((tx) =>
        tx.get<{ ownerId: string; callerId: string }>('tasks', r.parentTaskId!),
      );
      if (
        parent &&
        (parent.value.ownerId === caller.id ||
          parent.value.callerId === caller.id)
      )
        return r;
    }
    throw new AgentropyError('NotFound', 'Task not found');
  }

  snapshot(r: RemoteTaskRecord): TaskSnapshot {
    return {
      taskId: r.taskId,
      status: r.status,
      revision: r.revision,
      authority: 'remote',
      ...(r.outcome ? { outcome: r.outcome } : {}),
    } as TaskSnapshot;
  }

  async cancel(
    taskId: string,
    caller: TrustedPrincipal,
  ): Promise<TaskSnapshot> {
    const r = await this.get(taskId, caller);
    if (isTerminal(TASK_MACHINE, r.status))
      throw new AgentropyError('InvalidState', `Task is ${r.status}`);
    const state = await this.o.router
      .provider(r.route)
      .cancel(this.ref(r), { caller, correlationId: r.correlationId });
    return this.snapshot(
      await this.apply(
        r.taskId,
        state.normalized,
        state.remoteState,
        state.output,
      ),
    );
  }

  /** Refresh every non-terminal projection from its provider (called on each scheduler poll). */
  async sync(): Promise<number> {
    const open = (
      await this.store.transaction((tx) =>
        tx.find<RemoteTaskRecord>('remoteTasks', {}),
      )
    ).filter((r) => !isTerminal(TASK_MACHINE, r.value.status));
    let changed = 0;
    for (const doc of open) {
      const r = doc.value;
      try {
        const state = await this.o.router
          .provider(r.route)
          .getTask(this.ref(r), {
            caller: {
              id: r.callerId,
              type: r.callerType,
              tenantId: r.tenantId,
            },
            correlationId: r.correlationId,
          });
        const before = r.revision;
        const after = await this.apply(
          r.taskId,
          state.normalized,
          state.remoteState,
          state.output,
        );
        if (after.revision !== before) changed++;
      } catch (err) {
        // The remote task stays authoritative: an unreachable peer leaves the projection as last observed.
        await this.store.transaction(async (tx) => {
          const cur = await tx.get<RemoteTaskRecord>('remoteTasks', doc.id);
          if (cur)
            await tx.update('remoteTasks', cur.id, cur.revision, {
              ...cur.value,
              lastError: (err as { code?: string }).code ?? 'Internal',
            });
        });
      }
    }
    return changed;
  }

  private ref(r: RemoteTaskRecord): RemoteTaskRef {
    return {
      localTaskId: r.taskId,
      route: r.route,
      remoteTaskId: r.remoteTaskId,
    };
  }

  private async apply(
    taskId: string,
    normalized: TaskSnapshot['status'] | 'unknown',
    remoteState: string,
    output: unknown,
  ): Promise<RemoteTaskRecord> {
    return this.store.transaction(async (tx) => {
      const doc = (await tx.find<RemoteTaskRecord>('remoteTasks', {})).find(
        (d) => d.value.taskId === taskId,
      )!;
      const r = doc.value;
      if (
        normalized === 'unknown' ||
        (normalized === r.status && remoteState === r.remoteState)
      )
        return r;
      const next: RemoteTaskRecord = {
        ...r,
        status: normalized,
        remoteState,
        revision: r.revision + 1,
        observedAt: this.now(),
        ...(normalized === 'completed' && output !== undefined
          ? { output }
          : {}),
        ...(normalized === 'failed'
          ? {
              outcome: {
                code: 'TaskFailed',
                message: `Remote task ${remoteState}`,
              },
            }
          : normalized === 'cancelled'
            ? {
                outcome: {
                  code: 'TaskCancelled',
                  message: 'Remote task cancelled',
                },
              }
            : {}),
      };
      delete next.lastError;
      await tx.update<RemoteTaskRecord>(
        'remoteTasks',
        doc.id,
        doc.revision,
        next,
      );
      return next;
    });
  }
}
