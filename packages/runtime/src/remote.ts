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
 *
 * Every call to the peer (delegate, getTask, cancel) is bounded by `timeoutMs` (FIX-053): the provider gets an
 * AbortSignal that fires at the limit, and a provider that ignores it is given up on all the same, so a peer that
 * accepts the connection and never answers costs one `RemoteUnavailable` and never holds the caller.
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
  type StoredDocument,
  type TaskHandle,
  type TaskSnapshot,
  type TrustedPrincipal,
} from '@agentropy/core';
import { DEFAULT_LIMITS } from './limits.js';
import { hashKey, type TaskService } from './task-service.js';
import { pokeWakeups } from './wake-index.js';

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
  /** The scheduler asks the peer again from this time on (FEAT-039.2); absent means now. */
  nextSyncAt?: string;
  /** Polls in a row that found nothing new or failed; the wait doubles with each. */
  quiet?: number;
}

/** How often a projection is refreshed: `minMs` after a change, doubling per quiet poll up to `maxMs`. */
export interface RemoteSyncOptions {
  minMs?: number;
  maxMs?: number;
}

/** Longest one call to a peer may take unless configured otherwise. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;

/** Projections refreshed at once by one `sync`. */
const SYNC_CONCURRENCY = 8;

type RemoteTarget = NonNullable<DelegationRequest['target']['remote']>;

/** Statuses of a projection that still needs refreshing. */
const OPEN = ['created', 'assigned', 'running', 'waiting'] as const;

export class RemoteDelegationService {
  constructor(
    private readonly o: {
      tasks: TaskService;
      router: CommunicationRouter;
      sync?: RemoteSyncOptions;
      /** Longest one call to a peer may take (default 30 s); a longer one fails `RemoteUnavailable` (FIX-053). */
      timeoutMs?: number;
      /** Largest output a remote task may report (default `DEFAULT_LIMITS.maxOutputBytes`); a larger one fails it (TASK-068). */
      maxOutputBytes?: number;
    },
  ) {
    const ms = o.timeoutMs;
    if (ms !== undefined && (!Number.isInteger(ms) || ms < 1))
      throw new AgentropyError(
        'InvalidConfiguration',
        'communication.timeoutMs must be a positive integer',
        { details: { field: 'timeoutMs', value: String(ms) } },
      );
  }

  /**
   * Runs one call to a peer within `timeoutMs`. The provider's context carries a signal that fires at the limit (and
   * when the caller's own signal fires); the call is also raced against the limit, so a provider that ignores the
   * signal cannot hold the caller. What the abandoned call does later is contained.
   */
  private async bounded<T>(
    ctx: CallContext,
    call: (ctx: CallContext) => Promise<T>,
  ): Promise<T> {
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted) onCallerAbort();
    else ctx.signal?.addEventListener('abort', onCallerAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timedOut = new AgentropyError(
          'RemoteUnavailable',
          'The remote peer did not answer in time',
          { details: { reason: 'timeout' } },
        );
        abort.abort(timedOut);
        reject(timedOut);
      }, this.o.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS);
    });
    const running = call({ ...ctx, signal: abort.signal });
    running.catch(() => undefined); // a call given up on may still fail later: nobody is waiting for it
    try {
      return await Promise.race([running, limit]);
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Next refresh time after a poll that saw `quiet` quiet polls in a row (FEAT-039.2). */
  private due(quiet: number): string | undefined {
    const min = this.o.sync?.minMs ?? 1_000;
    const max = this.o.sync?.maxMs ?? 30_000;
    if (max <= 0) return undefined; // backoff off: refreshed on every poll
    const wait = Math.min(max, min * 2 ** Math.min(quiet, 20));
    return new Date(Date.parse(this.now()) + wait).toISOString();
  }

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
    const ref = await this.bounded({ ...ctx, caller: withoutGrant }, (c) =>
      this.o.router.provider(route).delegate(
        route,
        {
          target: {},
          input: request.input,
          idempotencyKey: request.idempotencyKey,
          correlationId: request.correlationId,
          ...(request.deadline ? { deadline: request.deadline } : {}),
        },
        c,
      ),
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
      tx.find<RemoteTaskRecord>('remoteTasks', { where: { taskId } }),
    );
    return rows[0];
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
    const state = await this.bounded(
      { caller, correlationId: r.correlationId },
      (c) => this.o.router.provider(r.route).cancel(this.ref(r), c),
    );
    return this.snapshot(
      await this.apply(
        r.taskId,
        state.normalized,
        state.remoteState,
        state.output,
      ),
    );
  }

  /**
   * Refresh the non-terminal projections that are due from their providers (called on each scheduler poll). A
   * projection that keeps showing nothing new, or whose peer is down, is asked less and less often (doubling from
   * `sync.minMs` up to `sync.maxMs`), so open remote tasks do not become a request every poll (FEAT-039.2).
   */
  async sync(): Promise<number> {
    const now = this.now();
    const open = (
      await this.store.transaction(async (tx) => {
        const rows: StoredDocument<RemoteTaskRecord>[] = [];
        for (const status of OPEN)
          rows.push(
            ...(await tx.find<RemoteTaskRecord>('remoteTasks', {
              where: { status },
            })),
          );
        return rows;
      })
    ).filter((d) => !d.value.nextSyncAt || d.value.nextSyncAt <= now);
    // A few at a time: peers that hang each cost their own timeout, not one after the other (FIX-053).
    let changed = 0;
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(SYNC_CONCURRENCY, open.length) },
        async () => {
          for (let doc = open[next++]; doc; doc = open[next++])
            if (await this.poll(doc)) changed++;
        },
      ),
    );
    return changed;
  }

  /** One poll of a projection: true when the peer's answer changed it; otherwise its next poll is pushed back. */
  private async poll(doc: StoredDocument<RemoteTaskRecord>): Promise<boolean> {
    const r = doc.value;
    try {
      const state = await this.bounded(
        {
          caller: {
            id: r.callerId,
            type: r.callerType,
            tenantId: r.tenantId,
          },
          correlationId: r.correlationId,
        },
        (c) => this.o.router.provider(r.route).getTask(this.ref(r), c),
      );
      const before = r.revision;
      const after = await this.apply(
        r.taskId,
        state.normalized,
        state.remoteState,
        state.output,
      );
      if (after.revision !== before) return true;
      await this.schedule(doc.id, (r.quiet ?? 0) + 1);
      return false;
    } catch (err) {
      // The remote task stays authoritative: an unreachable peer leaves the projection as last observed.
      await this.schedule(
        doc.id,
        (r.quiet ?? 0) + 1,
        (err as { code?: string }).code ?? 'Internal',
      );
      return false;
    }
  }

  private readonly refreshing = new Map<string, Promise<boolean>>();

  /**
   * Asks the peer for one open projection now, outside the poll schedule (FEAT-048.2: the A2A push notification
   * receiver calls this). True when the projection changed; false when it did not, is terminal, does not exist or the
   * peer could not be reached (recorded like a failed poll). Concurrent refreshes of one projection share one call.
   * Trusted host code only: it takes no principal, and what it applies is whatever the peer, the authority for the
   * task, answers.
   */
  refresh(taskId: string): Promise<boolean> {
    const running = this.refreshing.get(taskId);
    if (running) return running;
    const p = (async () => {
      const doc = await this.find(taskId);
      if (!doc || isTerminal(TASK_MACHINE, doc.value.status)) return false;
      return this.poll(doc);
    })().finally(() => this.refreshing.delete(taskId));
    this.refreshing.set(taskId, p);
    return p;
  }

  /** Records when the projection is asked next, and the error of a failed poll (cleared by a good one). */
  private async schedule(
    docId: string,
    quiet: number,
    error?: string,
  ): Promise<void> {
    const next = this.due(quiet);
    await this.store.transaction(async (tx) => {
      const cur = await tx.get<RemoteTaskRecord>('remoteTasks', docId);
      if (!cur || isTerminal(TASK_MACHINE, cur.value.status)) return;
      const value: RemoteTaskRecord = { ...cur.value, quiet };
      if (next) value.nextSyncAt = next;
      else delete value.nextSyncAt;
      if (error) value.lastError = error;
      if (
        error === undefined &&
        value.quiet === cur.value.quiet &&
        value.nextSyncAt === cur.value.nextSyncAt
      )
        return;
      await tx.update('remoteTasks', cur.id, cur.revision, value);
    });
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
      const doc = (
        await tx.find<RemoteTaskRecord>('remoteTasks', { where: { taskId } })
      )[0]!;
      const r = doc.value;
      if (
        normalized === 'unknown' ||
        (normalized === r.status && remoteState === r.remoteState)
      )
        return r;
      // A peer's output is bound like a local handler's: one over `maxOutputBytes` (or not JSON at all) fails the
      // projection with `SchemaViolation` instead of being stored whole (TASK-068).
      const maxOutputBytes =
        this.o.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes;
      let oversize = false;
      if (normalized === 'completed' && output !== undefined) {
        try {
          oversize = Buffer.byteLength(JSON.stringify(output)) > maxOutputBytes;
        } catch {
          oversize = true;
        }
      }
      if (oversize) {
        normalized = 'failed';
        output = undefined;
      }
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
              outcome: oversize
                ? {
                    code: 'SchemaViolation',
                    message: `Remote output exceeds the ${maxOutputBytes}-byte limit`,
                  }
                : {
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
      next.quiet = 0;
      const due = this.due(0);
      if (due) next.nextSyncAt = due;
      else delete next.nextSyncAt;
      await tx.update<RemoteTaskRecord>(
        'remoteTasks',
        doc.id,
        doc.revision,
        next,
      );
      if (r.parentTaskId) await pokeWakeups(tx, r.parentTaskId, this.now());
      return next;
    });
  }
}
