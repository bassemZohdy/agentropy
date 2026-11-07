/**
 * AgentRuntime and bounded in-process pool (runtime contract §1–2, ADR-0018): one execution per activation,
 * leases with epochs (fencing), disposition mapping, retries with backoff, cooperative cancel with a grace
 * period, lease-expiry recovery. Wake-up firing (T5) is owned by the scheduler/event layer.
 */
import {
  AgentropyError,
  EXECUTION_MACHINE,
  nextOccurrence,
  assertTransition,
  enforcePolicy,
  isAgentropyError,
  normalizeInstant,
  toAgentropyError,
  validateAgainst,
  type AgentContext,
  type AgentDisposition,
  type CheckpointCodec,
  type AgentInvocation,
  type CapabilityAccess,
  type CapabilityProvider,
  type SkillAccess,
  type StoreTx,
  type StoredDocument,
  type TelemetrySpan,
  METRICS,
  SPANS,
  type TrustedPrincipal,
  type WakeReason,
  type WakeupRequest,
} from '@agentropy/core';
import { randomUUID } from 'node:crypto';
import type { InMemoryImplementationProviderRegistry } from './implementation.js';
import {
  DEFAULT_RETRY,
  hashKey,
  type DispatchGate,
  type StoredExecution,
  type TaskRecord,
  type TaskService,
} from './task-service.js';

export interface WakeupRecord {
  id: string;
  taskId: string;
  conditions: WakeupRequest['anyOf'];
  timeoutAt?: string;
  onTimeout: 'resume' | 'fail';
  status: 'armed' | 'fired' | 'revoked';
  /** Due time per condition (timer/schedule), aligned with `conditions`; null for non-time conditions. */
  conditionDue: (string | null)[];
  /** Earliest time-based trigger (timer, schedule or timeout), for the polling scheduler. */
  dueAt: string | null;
  /**
   * When the scheduler next evaluates it (FEAT-033.2): `dueAt`, or the time something it waits for happened
   * (`pokeWakeups`); null when only a poke can make it fire. Absent on registrations armed before the index.
   */
  checkAt?: string | null;
  /** Set by whoever fires it; delivered to the next activation. */
  reason?: WakeReason;
  /** Sanitized traceparent of the inbound event that fired it; linked from the next execution span. */
  causeTraceparent?: string;
}

export interface RuntimeOptions {
  tasks: TaskService;
  implementations: InMemoryImplementationProviderRegistry;
  /** Capability providers by provider ID (bindings in the snapshot name them). */
  capabilityProviders: ReadonlyMap<string, CapabilityProvider>;
  poolSize?: number;
  leaseMs?: number;
  cancelGraceMs?: number;
  /** Longest one activation may run before it is aborted and fenced (default 10 min, FEAT-037.2). */
  maxActivationMs?: number;
  /**
   * Called with every failure the pool contains instead of letting it escape as an unhandled rejection: a
   * disposition that could not be written, a cancel or timeout fence that failed. Counted as
   * `agentropy.scheduler.errors` either way.
   */
  onError?: (error: AgentropyError) => void;
  /** Bounded execution history kept per task (R-37); older terminal executions are pruned. */
  keepExecutions?: number;
  skills?: (task: TaskRecord) => SkillAccess;
  /** Outbox relay drained on every tick and when the pool goes idle (R-29). */
  relay?: { drain(): Promise<number> };
  /** ADR-0024 gate: bounded re-checks after a policy outage (default 1 s doubling to 5 min, 8 evaluations). */
  gateRetry?: { initialMs: number; maxMs: number; maxAttempts: number };
  /** A policy decision slower than this is treated as unavailable (default 5 s). */
  pdpTimeoutMs?: number;
  /** Largest serialized checkpoint a waiting disposition may store (R-37; default 64 KiB). */
  maxCheckpointBytes?: number;
  /** Identity of this worker among those sharing the store (M3-02); recorded on every lease. */
  workerId?: string;
}

type GateReason = DispatchGate['reason'];

interface Admission {
  taskRevision: number;
  gateRevision: number | null;
  grantRef?: string;
}

const EMPTY_SKILLS: SkillAccess = {
  list: () => [],
  instructions: async (id) =>
    Promise.reject(
      new AgentropyError('CapabilityNotDeclared', `Skill ${id} is not pinned`),
    ),
  resource: async (id) =>
    Promise.reject(
      new AgentropyError('CapabilityNotDeclared', `Skill ${id} is not pinned`),
    ),
};

/**
 * Fair dispatch order (M3-02): round-robin across tenants, oldest first within each tenant, so one tenant's backlog
 * cannot starve another's on a shared pool.
 */
export function fairOrder<T extends { value: { tenantId?: string } }>(
  due: T[],
): T[] {
  const queues = new Map<string, T[]>();
  for (const e of due) {
    const k = e.value.tenantId ?? '';
    const q = queues.get(k);
    if (q) q.push(e);
    else queues.set(k, [e]);
  }
  const out: T[] = [];
  for (let i = 0; out.length < due.length; i++)
    for (const q of queues.values()) if (i < q.length) out.push(q[i]!);
  return out;
}

/** Applies the handler's checkpoint codec to a stored checkpoint (FEAT-028.3); never reinterprets silently. */
export function decodeCheckpoint(
  codec: CheckpointCodec | undefined,
  data: unknown,
  storedVersion: number | undefined,
): unknown {
  if (data === undefined) return undefined;
  const current = codec?.version ?? 1;
  const stored = storedVersion ?? 1;
  if (stored === current) return data;
  const fail = (message: string) =>
    new AgentropyError('IncompatibleVersion', message, {
      details: { kind: 'checkpoint', stored, current },
    });
  if (stored > current || !codec?.upgrade)
    throw fail(
      `Checkpoint version ${stored} cannot be read by a handler at version ${current}`,
    );
  try {
    return codec.upgrade(structuredClone(data), stored);
  } catch {
    throw fail(`Checkpoint upgrade from version ${stored} failed`);
  }
}

/**
 * A grace-period sleep that does not keep the process alive: nothing awaits it except a background fence, so a
 * shutdown must not wait for it (FEAT-037.3).
 */
const sleepUnref = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

const addMs = (iso: string, ms: number) =>
  new Date(Date.parse(iso) + ms).toISOString();

export class AgentRuntime {
  private readonly running = new Map<
    string,
    {
      done: Promise<void>;
      release: () => void;
      controller: AbortController;
      taskId: string;
    }
  >();
  private readonly o: Required<
    Omit<RuntimeOptions, 'skills' | 'relay' | 'onError'>
  > &
    Pick<RuntimeOptions, 'skills' | 'relay' | 'onError'>;

  constructor(options: RuntimeOptions) {
    this.o = {
      poolSize: 4,
      leaseMs: 60_000,
      cancelGraceMs: 30_000,
      maxActivationMs: 600_000,
      keepExecutions: 20,
      gateRetry: { initialMs: 1_000, maxMs: 300_000, maxAttempts: 8 },
      pdpTimeoutMs: 5_000,
      maxCheckpointBytes: 64 * 1024,
      workerId: `worker-${randomUUID()}`,
      ...options,
    };
    this.o.tasks.onCancelRequested((taskId) => {
      for (const [execId, r] of this.running)
        if (r.taskId === taskId)
          this.guard(this.cancelRunning(execId, r.controller));
    });
  }

  /**
   * Contains a background promise (cancel or timeout fence): its failure is counted and reported, never an
   * unhandled rejection that would end the process and every other execution with it (FEAT-037.2).
   */
  private guard(work: Promise<unknown>): void {
    work.catch((err: unknown) => this.report(err));
  }

  /** Counts and reports a failure the host contains (see `onError`). */
  report(err: unknown): void {
    const error = toAgentropyError(err);
    this.o.tasks.telemetry.count(METRICS.schedulerErrors, 1, {
      'agentropy.error.code': error.code,
    });
    try {
      this.o.onError?.(error);
    } catch {
      // A failing error hook must not break the pool either.
    }
  }

  private get store() {
    return this.o.tasks.o.store;
  }
  private now() {
    return this.o.tasks.o.now();
  }

  /** Recover expired leases, then lease due executions up to the free pool capacity. Returns how many started. */
  async tick(): Promise<number> {
    await this.renewLeases();
    await this.recoverExpiredLeases();
    await this.o.relay?.drain();
    const free = this.o.poolSize - this.running.size;
    if (free <= 0) return 0;
    const now = this.now();
    const due = fairOrder(
      (
        await this.store.transaction((tx) =>
          tx.find<StoredExecution>('executions', {
            where: { state: 'queued' },
          }),
        )
      ).filter((e) => e.value.runAt <= now && !this.running.has(e.id)),
    );
    // Cheap pre-check so tenants at their concurrency limit are not re-admitted every tick; lease() re-checks.
    const busy = new Map<string, number>();
    if (this.o.tasks.o.quotas)
      for (const r of await this.store.transaction((tx) =>
        tx.find<StoredExecution>('executions', { where: { state: 'running' } }),
      ))
        if (r.value.tenantId)
          busy.set(r.value.tenantId, (busy.get(r.value.tenantId) ?? 0) + 1);
    let started = 0;
    for (const e of due) {
      if (started >= free) break;
      const tenant = e.value.tenantId;
      const cap =
        tenant !== undefined
          ? this.o.tasks.o.quotas?.(tenant)?.maxConcurrentExecutions
          : undefined;
      if (cap !== undefined && (busy.get(tenant!) ?? 0) >= cap) continue;
      let leased: Awaited<ReturnType<typeof this.lease>>;
      try {
        const admission = await this.admit(e);
        if (!admission) continue;
        leased = await this.lease(e.id, admission);
      } catch (err) {
        // A failed audit intent aborts the gate or lease transaction: nothing is dispatched; retried next tick.
        if (isAgentropyError(err, 'AuditCommitUnavailable')) continue;
        throw err;
      }
      if (!leased) continue;
      if (tenant) busy.set(tenant, (busy.get(tenant) ?? 0) + 1);
      const controller = new AbortController();
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      this.running.set(e.id, {
        done,
        release,
        controller,
        taskId: leased.task.id,
      });
      // An activation that outlives maxActivationMs is aborted, then fenced if it ignores the signal.
      const limit = setTimeout(
        () => this.guard(this.timeoutRunning(e.id, controller)),
        this.o.maxActivationMs,
      );
      limit.unref();
      void this.execute(leased.exec, leased.task, controller)
        .catch((err: unknown) => this.report(err))
        .finally(() => {
          clearTimeout(limit);
          this.forget(e.id);
        });
      started++;
    }
    return started;
  }

  /**
   * Lease heartbeat (M2-01): extend the lease of every execution this pool is still running, so another worker
   * sharing the store does not recover it as lost while it makes progress. Fenced by state and epoch.
   */
  async renewLeases(): Promise<number> {
    if (!this.running.size) return 0;
    const ids = [...this.running.keys()];
    const cancelled: string[] = [];
    const fenced: string[] = [];
    const renewed = await this.store.transaction(async (tx) => {
      cancelled.length = fenced.length = 0;
      let n = 0;
      for (const id of ids) {
        const e = await tx.get<StoredExecution>('executions', id);
        if (!e || e.value.state !== 'running') {
          // Another worker recovered this lease (we stalled past expiry): stop the handler, its result is fenced.
          fenced.push(id);
          continue;
        }
        await tx.update<StoredExecution>('executions', id, e.revision, {
          ...e.value,
          leaseExpiresAt: addMs(this.now(), this.o.leaseMs),
        });
        n++;
        // A cancel accepted by another worker reaches this one through the store (M3-02).
        const t = await tx.get<TaskRecord>('tasks', e.value.taskId);
        if (t?.value.cancelRequestedAt) cancelled.push(id);
      }
      return n;
    });
    for (const id of fenced)
      this.running
        .get(id)
        ?.controller.abort(
          new AgentropyError('StaleRevision', 'Execution lease was lost'),
        );
    for (const id of cancelled) {
      const r = this.running.get(id);
      if (r && !r.controller.signal.aborted)
        this.guard(this.cancelRunning(id, r.controller));
    }
    return renewed;
  }

  /** This worker's identity (M3-02). */
  get workerId(): string {
    return this.o.workerId;
  }

  /**
   * Revocation checkpoint (D-20): signal every execution this pool is running under `grantRef` to stop. The
   * handler sees its AbortSignal fire with `AuthorityExpired` (status revoked); its next protected effect is refused
   * anyway (grants are checked per operation), and the task waits behind the dispatch gate. Committed effects are
   * not rolled back: they stay in the effect journal for authorized compensation. Returns the affected task IDs.
   */
  async revokeAuthority(grantRef: string, tenantId: string): Promise<string[]> {
    const affected: string[] = [];
    for (const r of this.running.values()) {
      const t = await this.store.transaction((tx) =>
        tx.get<TaskRecord>('tasks', r.taskId),
      );
      if (t?.value.grantRef !== grantRef || t.value.tenantId !== tenantId)
        continue;
      r.controller.abort(
        new AgentropyError('AuthorityExpired', 'Delegated authority revoked', {
          details: { status: 'revoked' },
        }),
      );
      affected.push(t.id);
    }
    return affected;
  }

  /** Wait for every in-flight execution to settle. */
  async idle(): Promise<void> {
    while (this.running.size)
      await Promise.all([...this.running.values()].map((r) => r.done));
  }

  /** Drop an execution from the pool (settled, or fenced after a cancel grace period). */
  private forget(executionId: string): void {
    const r = this.running.get(executionId);
    if (!r) return;
    this.running.delete(executionId);
    r.release();
  }

  /** Tick and settle until no due work remains (bounded). */
  async runUntilIdle(maxRounds = 100): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const started = await this.tick();
      await this.idle();
      if (started === 0) break;
    }
    await this.o.relay?.drain();
  }

  get activeCount(): number {
    return this.running.size;
  }

  /**
   * ADR-0024 activation eligibility gate, evaluated before every lease with a fresh grant check and policy
   * decision. A blocked task keeps its status (`assigned`) and its queued execution; the gate row records why,
   * and when (if ever) to look again. Deadlines are enforced while gated (T9). Returns undefined when not admitted.
   */
  private async admit(
    e: StoredDocument<StoredExecution>,
  ): Promise<Admission | undefined> {
    const now = this.now();
    const [task, gate] = await this.store.transaction(
      async (tx) =>
        [
          await tx.get<TaskRecord>('tasks', e.value.taskId),
          await tx.get<DispatchGate>('gates', e.value.taskId),
        ] as const,
    );
    if (!task || task.value.status !== 'assigned') return undefined;
    if (task.value.deadline && task.value.deadline <= now) {
      await this.store.transaction(async (tx) => {
        const cur = await tx.get<TaskRecord>('tasks', task.id);
        if (cur && cur.revision === task.revision)
          await this.o.tasks.terminate(tx, cur, 'failed', 'T9', {
            code: 'Timeout',
            message: 'Task deadline passed',
          });
      });
      return undefined;
    }
    // No busy retries: a gate waits for its scheduled check, or for reauthorization when it has none.
    if (
      gate &&
      (gate.value.nextCheckAt === null || gate.value.nextCheckAt > now)
    )
      return undefined;
    const grantRef = gate?.value.grantRef ?? task.value.grantRef;
    const verdict = await this.dispatchDecision(task.value, grantRef);
    if (verdict === 'allow')
      return {
        taskRevision: task.revision,
        gateRevision: gate?.revision ?? null,
        ...(grantRef ? { grantRef } : {}),
      };
    await this.store.transaction(async (tx) => {
      const t = await tx.get<TaskRecord>('tasks', task.id);
      const g = await tx.get<DispatchGate>('gates', task.id);
      // CAS on both the task and the gate: a concurrent scheduler or a cancel wins, this decision is dropped.
      if (!t || t.revision !== task.revision) return;
      if ((g?.revision ?? null) !== (gate?.revision ?? null)) return;
      await this.writeGate(tx, t, g, verdict, grantRef);
    });
    return undefined;
  }

  private async writeGate(
    tx: StoreTx,
    t: StoredDocument<TaskRecord>,
    g: StoredDocument<DispatchGate> | undefined,
    reason: GateReason,
    grantRef: string | undefined,
  ): Promise<void> {
    const now = this.now();
    const attempt = (g?.value.attempt ?? 0) + 1;
    const r = this.o.gateRetry;
    const retry = reason === 'policy-indeterminate' && attempt < r.maxAttempts;
    const value: DispatchGate = {
      taskId: t.id,
      taskRevision: t.revision,
      reason,
      nextCheckAt: retry
        ? addMs(now, Math.min(r.maxMs, r.initialMs * 2 ** (attempt - 1)))
        : null,
      ...(grantRef ? { grantRef } : {}),
      lastDecisionAt: now,
      attempt,
    };
    this.o.tasks.telemetry.count(METRICS.dispatchGated, 1, {
      'agentropy.gate.reason': reason,
    });
    if (g) await tx.update<DispatchGate>('gates', g.id, g.revision, value);
    else await tx.insert<DispatchGate>('gates', t.id, value);
    await this.o.tasks.audit(
      tx,
      { id: t.value.callerId, tenantId: t.value.tenantId },
      {
        type: 'task.dispatch',
        action: 'task:dispatch',
        resource: { type: 'task', id: t.id },
        decision: reason === 'policy-indeterminate' ? 'error' : 'deny',
        details: { reason, attempt, retry },
        correlationId: t.value.correlationId,
        taskId: t.id,
      },
    );
  }

  /** Fresh grant check and policy decision for dispatching a task; never reuses an earlier Allow. */
  private async dispatchDecision(
    t: TaskRecord,
    grantRef: string | undefined,
  ): Promise<'allow' | GateReason> {
    const grants = this.o.tasks.o.grants;
    if (grantRef && grants) {
      let status: string;
      try {
        status = await grants.check(grantRef, t.tenantId);
      } catch {
        return 'policy-indeterminate';
      }
      if (status === 'expired') return 'authority-expired';
      if (status !== 'valid') return 'authority-revoked';
    }
    const principal: TrustedPrincipal = {
      id: t.callerId,
      type: t.callerType ?? 'user',
      tenantId: t.tenantId,
      ...(grantRef ? { delegatedAuthorityRef: grantRef } : {}),
    };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const decision = await Promise.race([
        this.o.tasks.o.pdp.decide(
          {
            principal,
            action: 'task:dispatch',
            resource: {
              type: 'agent-instance',
              id: t.instanceId,
              tenantId: t.tenantId,
            },
          },
          abort.signal,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error('policy decision timed out'));
          }, this.o.pdpTimeoutMs);
        }),
      ]);
      const effect = (decision as { effect?: unknown } | null)?.effect;
      if (effect === 'allow') return 'allow';
      if (effect === 'deny') return 'policy-denied';
      return 'policy-indeterminate';
    } catch {
      return 'policy-indeterminate';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Store-wide per-tenant concurrency (M3-02, `maxConcurrentExecutions`): counted inside the lease transaction over
   * every worker's running executions, so workers sharing the store cannot overshoot together.
   */
  private async tenantAtCapacity(
    tx: StoreTx,
    tenantId: string | undefined,
  ): Promise<boolean> {
    if (!tenantId) return false;
    const limit = this.o.tasks.o.quotas?.(tenantId)?.maxConcurrentExecutions;
    if (limit === undefined) return false;
    const running = (
      await tx.find<StoredExecution>('executions', {
        where: { state: 'running' },
      })
    ).filter((x) => x.value.tenantId === tenantId).length;
    return running >= limit;
  }

  /** E2+E3 with T3 in one transaction; the lease epoch fences every later write of this execution. */
  private async lease(
    executionId: string,
    admission: Admission,
  ): Promise<
    | {
        exec: StoredDocument<StoredExecution>;
        task: StoredDocument<TaskRecord>;
      }
    | undefined
  > {
    return this.store.transaction(async (tx) => {
      const e = await tx.get<StoredExecution>('executions', executionId);
      if (!e || e.value.state !== 'queued') return undefined;
      const t = (await tx.get<TaskRecord>('tasks', e.value.taskId))!;
      if (t.value.status !== 'assigned') return undefined;
      if (await this.tenantAtCapacity(tx, t.value.tenantId)) return undefined;
      // Lease fence (ADR-0024): the admission decision is only valid for the task and gate revisions it saw.
      const gate = await tx.get<DispatchGate>('gates', t.id);
      if (
        t.revision !== admission.taskRevision ||
        (gate?.revision ?? null) !== admission.gateRevision
      )
        return undefined;
      if (gate) {
        await tx.remove('gates', gate.id, gate.revision);
        await this.o.tasks.audit(
          tx,
          { id: t.value.callerId, tenantId: t.value.tenantId },
          {
            type: 'task.dispatch',
            action: 'task:dispatch',
            resource: { type: 'task', id: t.id },
            decision: 'allow',
            details: { after: gate.value.reason, attempts: gate.value.attempt },
            correlationId: t.value.correlationId,
            taskId: t.id,
          },
        );
      }
      const epoch = (t.value.leaseEpoch ?? 0) + 1;
      assertTransition(EXECUTION_MACHINE, 'queued', 'leased', 'E2');
      assertTransition(EXECUTION_MACHINE, 'leased', 'running', 'E3');
      const now = this.now();
      const exec = await tx.update<StoredExecution>(
        'executions',
        e.id,
        e.revision,
        {
          ...e.value,
          state: 'running',
          leaseEpoch: epoch,
          leaseExpiresAt: addMs(now, this.o.leaseMs),
          startedAt: now,
          tenantId: t.value.tenantId,
          workerId: this.o.workerId,
        },
      );
      const task = await this.o.tasks.transition(tx, t, 'running', 'T3', {
        leaseEpoch: epoch,
        ...(admission.grantRef ? { grantRef: admission.grantRef } : {}),
      });
      return { exec, task };
    });
  }

  private async execute(
    exec: StoredDocument<StoredExecution>,
    task: StoredDocument<TaskRecord>,
    controller: AbortController,
  ): Promise<void> {
    const t = task.value;
    const telemetry = this.o.tasks.telemetry;
    const started = performance.now();
    let disposition:
      AgentDisposition<unknown> | { kind: 'threw'; error: AgentropyError };
    let span: TelemetrySpan | undefined;
    let codecVersion = 1;
    try {
      const provider = this.o.implementations.get(
        t.snapshot.implementation.providerId,
        t.snapshot.implementation.providerVersion,
      );
      const agent = provider.createAgent(t.snapshot.implementation);
      const resumed = await this.resumeState(t.taskId, exec.value.trigger);
      const { wakeReason, causeTraceparent } = resumed;
      codecVersion = agent.checkpointCodec?.version ?? 1;
      const checkpoint = decodeCheckpoint(
        agent.checkpointCodec,
        resumed.checkpoint,
        resumed.checkpointVersion,
      );
      span = telemetry.startSpan(SPANS.execute, {
        kind: 'consumer',
        ...(t.traceparent ? { parent: t.traceparent } : {}),
        ...(causeTraceparent ? { links: [causeTraceparent] } : {}),
        attributes: {
          'agentropy.tenant.id': t.tenantId,
          'agentropy.task.id': t.taskId,
          'agentropy.execution.id': exec.id,
          'agentropy.agent.id': t.snapshot.definition.id,
          'agentropy.activation': exec.value.activation,
          'agentropy.attempt': exec.value.attempt,
          'agentropy.trigger': exec.value.trigger,
          ...(wakeReason ? { 'agentropy.wake.kind': wakeReason.kind } : {}),
        },
      });
      const invocation: AgentInvocation = {
        taskId: t.taskId,
        executionId: exec.id,
        activation: exec.value.activation,
        attempt: exec.value.attempt,
        input: t.input,
        trigger: exec.value.trigger,
        ...(checkpoint !== undefined ? { checkpoint } : {}),
        ...(wakeReason ? { wakeReason } : {}),
      };
      disposition = await agent.handle(
        invocation,
        this.context(t, exec, controller, span.traceparent),
      );
      // Validate a wake-up request before it reaches the transition transaction (invalid → non-retryable failure).
      if (disposition.kind === 'waiting') {
        if (!disposition.wakeup?.anyOf?.length) {
          throw new AgentropyError(
            'SchemaViolation',
            'A waiting disposition needs at least one wake-up condition',
            { details: { reason: 'wakeup' } },
          );
        }
        // Timers and the timeout are compared as strings: only UTC ISO-8601 instants get through (FEAT-038.3).
        disposition = {
          ...disposition,
          wakeup: {
            ...disposition.wakeup,
            anyOf: disposition.wakeup.anyOf.map((c) =>
              c.kind === 'timer'
                ? { ...c, at: normalizeInstant(c.at, 'timer.at') }
                : c,
            ),
            ...(disposition.wakeup.timeoutAt !== undefined
              ? {
                  timeoutAt: normalizeInstant(
                    disposition.wakeup.timeoutAt,
                    'timeoutAt',
                  ),
                }
              : {}),
          },
        };
        for (const c of disposition.wakeup.anyOf)
          if (c.kind === 'schedule')
            nextOccurrence(c.cron, c.timezone, this.now());
        // Long-lived tasks cycle through activations; their checkpoint must stay bounded (R-37, AC-20).
        const size = Buffer.byteLength(
          JSON.stringify(disposition.checkpoint ?? null),
        );
        if (size > this.o.maxCheckpointBytes)
          throw new AgentropyError(
            'SchemaViolation',
            `Checkpoint of ${size} bytes exceeds the ${this.o.maxCheckpointBytes}-byte limit`,
            {
              details: {
                reason: 'checkpointTooLarge',
                size,
                limit: this.o.maxCheckpointBytes,
              },
            },
          );
        // A human action's dueAt is its only timeout (human-actions.md "Expiry (single mechanism)").
        if (
          disposition.wakeup.timeoutAt &&
          disposition.wakeup.anyOf.some((c) => c.kind === 'human-action')
        )
          throw new AgentropyError(
            'SchemaViolation',
            'A human-action wait must not set timeoutAt; the request dueAt is its timeout',
            { details: { reason: 'humanActionTimeout' } },
          );
      }
    } catch (err) {
      disposition = {
        kind: 'threw',
        error: toAgentropyError(err, t.correlationId),
      };
    }
    const outcome =
      disposition.kind === 'threw'
        ? disposition.error.code
        : disposition.kind === 'failed'
          ? disposition.code
          : undefined;
    span?.setAttributes({ 'agentropy.disposition': disposition.kind });
    if (outcome) span?.fail(outcome);
    span?.end();
    telemetry.record(METRICS.executionDuration, performance.now() - started, {
      'agentropy.agent.id': t.snapshot.definition.id,
      'agentropy.disposition': disposition.kind,
    });
    await this.settle(exec, disposition, codecVersion);
  }

  /**
   * Writes the disposition, retrying a store failure a few times. A fenced (stale-epoch) write is expected after lease
   * loss, cancel grace expiry or a timeout fence: the result is discarded. If the store stays down the failure is
   * reported and the execution is left to lease expiry, which recovers it (E8, then retry or failure) once the
   * store is back; the pool and its other executions carry on (FEAT-037.2).
   */
  private async settle(
    exec: StoredDocument<StoredExecution>,
    d: AgentDisposition<unknown> | { kind: 'threw'; error: AgentropyError },
    codecVersion: number,
  ): Promise<void> {
    const attempts = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.applyDisposition(exec, d, codecVersion);
        return;
      } catch (err) {
        if (isAgentropyError(err, 'StaleRevision')) return;
        if (attempt >= attempts) return this.report(err);
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
  }

  private async resumeState(
    taskId: string,
    trigger: AgentInvocation['trigger'],
  ): Promise<{
    checkpoint?: unknown;
    checkpointVersion?: number;
    wakeReason?: WakeReason;
    causeTraceparent?: string;
  }> {
    return this.store.transaction(async (tx) => {
      const cp = await tx.get<{ data: unknown; version?: number }>(
        'checkpoints',
        taskId,
      );
      const stored = cp
        ? {
            checkpoint: cp.value.data,
            checkpointVersion: cp.value.version ?? 1,
          }
        : {};
      if (trigger !== 'resume') return stored;
      const fired = (
        await tx.find<WakeupRecord>('wakeups', {
          where: { taskId, status: 'fired' },
        })
      ).at(-1);
      return {
        ...stored,
        ...(fired?.value.reason ? { wakeReason: fired.value.reason } : {}),
        ...(fired?.value.causeTraceparent
          ? { causeTraceparent: fired.value.causeTraceparent }
          : {}),
      };
    });
  }

  /** Applies a disposition only if this execution still holds the lease (same epoch, still running). */
  private async applyDisposition(
    exec: StoredDocument<StoredExecution>,
    d: AgentDisposition<unknown> | { kind: 'threw'; error: AgentropyError },
    codecVersion = 1,
  ): Promise<void> {
    await this.store.transaction(async (tx) => {
      const e = await tx.get<StoredExecution>('executions', exec.id);
      const cur = (await tx.get<TaskRecord>('tasks', exec.value.taskId))!;
      if (
        !e ||
        e.value.state !== 'running' ||
        e.value.leaseEpoch !== exec.value.leaseEpoch ||
        cur.value.leaseEpoch !== exec.value.leaseEpoch
      ) {
        throw new AgentropyError(
          'StaleRevision',
          'Execution no longer holds the lease',
          { details: { reason: 'fenced' } },
        );
      }
      const end = (state: StoredExecution['state'], edge: string) => {
        assertTransition(EXECUTION_MACHINE, 'running', state, edge);
        return tx.update<StoredExecution>('executions', e.id, e.revision, {
          ...e.value,
          state,
          endedAt: this.now(),
        });
      };
      const t = cur.value;
      if (t.cancelRequestedAt) {
        await end('aborted', 'E7b');
        await this.o.tasks.terminate(tx, cur, 'cancelled', 'T11', {
          code: 'Cancelled',
          message: 'cancelled',
        });
        return this.prune(tx, t.taskId);
      }
      if (d.kind === 'completed') {
        const def = this.o.tasks.o.definitions.require(t.definition);
        try {
          if (def.outputSchema !== undefined)
            validateAgainst(def.outputSchema, d.output, `${def.id} output`);
        } catch {
          await end('failed', 'E6');
          await this.o.tasks.terminate(tx, cur, 'failed', 'T8', {
            code: 'SchemaViolation',
            message: 'Output does not match outputSchema',
          });
          return this.prune(tx, t.taskId);
        }
        await end('succeeded', 'E4');
        await this.o.tasks.terminate(
          tx,
          cur,
          'completed',
          'T7',
          undefined,
          d.output,
        );
        return this.prune(tx, t.taskId);
      }
      if (d.kind === 'waiting') {
        await end('yielded', 'E5');
        // T4: checkpoint and wake-up registration commit together, before the lease is released.
        const cp = await tx.get('checkpoints', t.taskId);
        if (cp)
          await tx.update('checkpoints', t.taskId, cp.revision, {
            taskId: t.taskId,
            data: d.checkpoint,
            version: codecVersion,
          });
        else
          await tx.insert('checkpoints', t.taskId, {
            taskId: t.taskId,
            data: d.checkpoint,
            version: codecVersion,
          });
        for (const old of await tx.find<WakeupRecord>('wakeups', {
          where: { taskId: t.taskId, status: 'fired' },
        })) {
          await tx.update('wakeups', old.id, old.revision, {
            ...old.value,
            status: 'revoked',
          });
        }
        // Per-condition due times: timers fire at `at`, schedules at their next occurrence (re-registered each activation).
        const conditionDue = d.wakeup.anyOf.map((c) =>
          c.kind === 'timer'
            ? c.at
            : c.kind === 'schedule'
              ? nextOccurrence(c.cron, c.timezone, this.now())
              : null,
        );
        // The task's own deadline is a due time too: a waiting task past it fails with T9 (FEAT-038.1).
        const times = [
          ...conditionDue.filter((x): x is string => x !== null),
          ...(d.wakeup.timeoutAt ? [d.wakeup.timeoutAt] : []),
          ...(t.deadline ? [t.deadline] : []),
        ].sort();
        const id = this.o.tasks.newId('wakeup');
        await tx.insert<WakeupRecord>('wakeups', id, {
          id,
          taskId: t.taskId,
          conditions: d.wakeup.anyOf,
          conditionDue,
          ...(d.wakeup.timeoutAt ? { timeoutAt: d.wakeup.timeoutAt } : {}),
          onTimeout: d.wakeup.onTimeout ?? 'resume',
          status: 'armed',
          dueAt: times[0] ?? null,
          // Non-time conditions may already hold (an event in the mailbox, a finished child): check once now.
          checkAt: conditionDue.includes(null)
            ? this.now()
            : (times[0] ?? null),
        });
        await this.o.tasks.transition(tx, cur, 'waiting', 'T4', {
          waitingOn: d.wakeup,
        });
        return this.prune(tx, t.taskId);
      }
      // Lost authority or an unavailable policy decision at a protected effect is not a handler failure:
      // the task goes back to `assigned` behind the dispatch gate (T6), keeping its checkpoint and journal.
      if (
        d.kind === 'threw' &&
        (d.error.code === 'AuthorityExpired' ||
          d.error.code === 'PolicyDecisionUnavailable')
      ) {
        await end('failed', 'E6');
        const next = await this.o.tasks.transition(tx, cur, 'assigned', 'T6');
        await this.o.tasks.queueExecution(
          tx,
          t.taskId,
          t.activation,
          t.attempt,
          'retry',
          this.now(),
        );
        const status = d.error.details?.['status'];
        await this.writeGate(
          tx,
          next,
          await tx.get<DispatchGate>('gates', t.taskId),
          d.error.code === 'PolicyDecisionUnavailable'
            ? 'policy-indeterminate'
            : status === 'revoked'
              ? 'authority-revoked'
              : 'authority-expired',
          t.grantRef,
        );
        return this.prune(tx, t.taskId);
      }
      const failure =
        d.kind === 'threw'
          ? {
              code: d.error.code,
              message: d.error.message,
              retryable: d.error.code === 'Internal' ? true : d.error.retryable,
            }
          : { code: d.code, message: d.message, retryable: d.retryable };
      await end('failed', 'E6');
      const policy = t.retryPolicy ?? DEFAULT_RETRY;
      if (failure.retryable && t.attempt < policy.maxAttempts) {
        const delay = Math.min(
          policy.backoff.maxMs,
          policy.backoff.initialMs *
            policy.backoff.multiplier ** (t.attempt - 1),
        );
        const next = await this.o.tasks.transition(tx, cur, 'assigned', 'T6', {
          attempt: t.attempt + 1,
        });
        await this.o.tasks.queueExecution(
          tx,
          t.taskId,
          t.activation,
          next.value.attempt,
          'retry',
          addMs(this.now(), delay),
        );
      } else {
        await this.o.tasks.terminate(tx, cur, 'failed', 'T8', {
          code: failure.code,
          message: failure.message,
        });
      }
      return this.prune(tx, t.taskId);
    });
  }

  /** E8 for executions whose lease expired (crashed worker); the task retries (T6) or fails (T8). */
  async recoverExpiredLeases(): Promise<number> {
    const now = this.now();
    return this.store.transaction(async (tx) => {
      let recovered = 0;
      for (const state of ['leased', 'running'] as const) {
        for (const e of await tx.find<StoredExecution>('executions', {
          where: { state },
        })) {
          if (
            !e.value.leaseExpiresAt ||
            e.value.leaseExpiresAt > now ||
            this.running.has(e.id)
          )
            continue;
          assertTransition(EXECUTION_MACHINE, state, 'lost', 'E8');
          await tx.update<StoredExecution>('executions', e.id, e.revision, {
            ...e.value,
            state: 'lost',
            endedAt: now,
          });
          const cur = (await tx.get<TaskRecord>('tasks', e.value.taskId))!;
          if (cur.value.status !== 'running') continue;
          recovered++;
          if (cur.value.cancelRequestedAt) {
            await this.o.tasks.terminate(tx, cur, 'cancelled', 'T11', {
              code: 'Cancelled',
              message: 'cancelled',
            });
          } else if (
            cur.value.attempt <
            (cur.value.retryPolicy ?? DEFAULT_RETRY).maxAttempts
          ) {
            const next = await this.o.tasks.transition(
              tx,
              cur,
              'assigned',
              'T6',
              { attempt: cur.value.attempt + 1 },
            );
            await this.o.tasks.queueExecution(
              tx,
              cur.id,
              cur.value.activation,
              next.value.attempt,
              'retry',
              now,
            );
          } else {
            await this.o.tasks.terminate(tx, cur, 'failed', 'T8', {
              code: 'Internal',
              message: 'Lease lost and attempts exhausted',
            });
          }
        }
      }
      return recovered;
    });
  }

  /**
   * maxActivationMs elapsed (FEAT-037.2): abort the handler with `Timeout`; if it has not returned after the grace
   * period, fence it as a lost lease — its lease is set to expire now and the next recovery applies E8 and the
   * task's retry policy (T6, or T8 when attempts are exhausted). Its late result is discarded by the fence.
   */
  private async timeoutRunning(
    executionId: string,
    controller: AbortController,
  ): Promise<void> {
    if (controller.signal.aborted) return;
    controller.abort(
      new AgentropyError('Timeout', 'Activation exceeded maxActivationMs'),
    );
    await sleepUnref(this.o.cancelGraceMs);
    if (!this.running.has(executionId)) return;
    await this.store.transaction(async (tx) => {
      const e = await tx.get<StoredExecution>('executions', executionId);
      if (e?.value.state === 'running')
        await tx.update<StoredExecution>('executions', e.id, e.revision, {
          ...e.value,
          leaseExpiresAt: this.now(),
        });
    });
    this.forget(executionId);
    await this.recoverExpiredLeases();
  }

  /** Cooperative cancel: fire AbortSignal; if the handler has not returned after the grace period, fence it (E8 + T11). */
  private async cancelRunning(
    executionId: string,
    controller: AbortController,
  ): Promise<void> {
    controller.abort(
      new AgentropyError('TaskCancelled', 'Task cancellation requested'),
    );
    await sleepUnref(this.o.cancelGraceMs);
    if (!this.running.has(executionId)) return;
    await this.store.transaction(async (tx) => {
      const e = await tx.get<StoredExecution>('executions', executionId);
      if (!e || e.value.state !== 'running') return;
      assertTransition(EXECUTION_MACHINE, 'running', 'lost', 'E8');
      await tx.update<StoredExecution>('executions', e.id, e.revision, {
        ...e.value,
        state: 'lost',
        endedAt: this.now(),
      });
      const cur = (await tx.get<TaskRecord>('tasks', e.value.taskId))!;
      if (cur.value.status === 'running')
        await this.o.tasks.terminate(tx, cur, 'cancelled', 'T11', {
          code: 'Cancelled',
          message: 'cancel grace period expired',
        });
    });
    this.forget(executionId); // the late result, if any, is fenced by applyDisposition
  }

  /** Keep only the last N terminal executions of a task (R-37). */
  private async prune(tx: StoreTx, taskId: string): Promise<void> {
    const terminal = (
      await tx.find<StoredExecution>('executions', { where: { taskId } })
    ).filter((e) => !['queued', 'leased', 'running'].includes(e.value.state));
    for (const e of terminal.slice(
      0,
      Math.max(0, terminal.length - this.o.keepExecutions),
    ))
      await tx.remove('executions', e.id, e.revision);
  }

  private context(
    t: TaskRecord,
    exec: StoredDocument<StoredExecution>,
    controller: AbortController,
    traceparent?: string,
  ): AgentContext {
    const principal: TrustedPrincipal = {
      id: t.instanceId,
      type: 'agent',
      tenantId: t.tenantId,
      ...(t.grantRef ? { delegatedAuthorityRef: t.grantRef } : {}),
    };
    return {
      tenantId: t.tenantId,
      agentInstanceId: t.instanceId,
      taskId: t.taskId,
      executionId: exec.id,
      principal,
      correlationId: t.correlationId,
      ...(t.deadline ? { deadline: t.deadline } : {}),
      signal: controller.signal,
      capabilities: this.capabilityAccess(
        t,
        exec.id,
        principal,
        controller.signal,
        traceparent,
      ),
      progress: {
        report: async (p) => {
          await this.store.transaction(async (tx) => {
            const cur = (await tx.get<TaskRecord>('tasks', t.taskId))!;
            await this.o.tasks.emit(
              tx,
              cur.value,
              cur.revision,
              'agentProgressUpdated',
              p,
            );
          });
        },
      },
      skills: this.o.skills?.(t) ?? EMPTY_SKILLS,
    };
  }

  /** The only handler effect surface: pinned bindings, declared operations, step keys, fresh authorization. */
  private capabilityAccess(
    t: TaskRecord,
    executionId: string,
    principal: TrustedPrincipal,
    signal: AbortSignal,
    traceparent?: string,
  ): CapabilityAccess {
    const telemetry = this.o.tasks.telemetry;
    const traced = async <O>(
      capabilityId: string,
      operation: string,
      run: (span: TelemetrySpan) => Promise<O>,
    ): Promise<O> => {
      const span = telemetry.startSpan(SPANS.capability, {
        kind: 'client',
        ...(traceparent ? { parent: traceparent } : {}),
        attributes: {
          'agentropy.task.id': t.taskId,
          'agentropy.capability.id': capabilityId,
          'agentropy.capability.operation': operation,
        },
      });
      let result = 'ok';
      try {
        return await run(span);
      } catch (err) {
        result = (err as { code?: string }).code ?? 'Internal';
        span.fail(result);
        throw err;
      } finally {
        span.end();
        telemetry.count(METRICS.capabilityCalls, 1, {
          'agentropy.capability.id': capabilityId,
          'agentropy.capability.operation': operation,
          'agentropy.result': result,
        });
      }
    };
    return {
      invoke: <I, O>(
        capabilityId: string,
        operation: string,
        input: I,
        options: { stepKey?: string } = {},
      ): Promise<O> =>
        traced(capabilityId, operation, async (span) => {
          const binding = t.snapshot.bindings.find(
            (b) => b.id === capabilityId,
          );
          if (!binding)
            throw new AgentropyError(
              'CapabilityNotDeclared',
              `Capability ${capabilityId} is not in this task's snapshot`,
              { details: { id: capabilityId } },
            );
          const contract = this.o.tasks.o.acceptance.contracts.find(
            (c) => c.id === binding.id && c.version === binding.version,
          );
          const op = contract?.operations.find((x) => x.name === operation);
          if (!op)
            throw new AgentropyError(
              'UnsupportedOperation',
              `${capabilityId}.${operation} is not declared`,
              { details: { id: capabilityId, operation } },
            );
          if (op.effect === 'external' && !options.stepKey)
            throw new AgentropyError(
              'SchemaViolation',
              `${capabilityId}.${operation} requires a stepKey`,
              { details: { reason: 'missingStepKey' } },
            );
          // SEC-02: every protected (non-read) effect re-validates the delegated grant; no stale Allow.
          if (op.effect !== 'read' && t.grantRef && this.o.tasks.o.grants) {
            const status = await this.o.tasks.o.grants
              .check(t.grantRef, t.tenantId)
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
          await enforcePolicy(
            this.o.tasks.o.pdp,
            {
              principal,
              action: op.permission,
              resource: {
                type: 'capability',
                id: capabilityId,
                tenantId: t.tenantId,
              },
            },
            signal,
          );
          const provider = this.o.capabilityProviders.get(binding.providerId);
          if (!provider)
            throw new AgentropyError(
              'ProviderUnavailable',
              `Capability provider ${binding.providerId} is not available`,
              { details: { id: capabilityId } },
            );
          return provider.invoke<I, O>(operation, input, {
            tenantId: t.tenantId,
            taskId: t.taskId,
            executionId,
            principalId: principal.id,
            ...(principal.delegatedAuthorityRef
              ? { delegatedAuthorityRef: principal.delegatedAuthorityRef }
              : {}),
            ...(options.stepKey
              ? {
                  stepKey: options.stepKey,
                  idempotencyKey: hashKey(
                    t.tenantId,
                    t.taskId,
                    capabilityId,
                    operation,
                    options.stepKey,
                  ),
                }
              : {}),
            ...(span.traceparent ? { traceparent: span.traceparent } : {}),
            signal,
          });
        }),
    };
  }
}
