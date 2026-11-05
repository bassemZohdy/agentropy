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
  toAgentropyError,
  validateAgainst,
  type AgentContext,
  type AgentDisposition,
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
  private readonly o: Required<Omit<RuntimeOptions, 'skills' | 'relay'>> &
    Pick<RuntimeOptions, 'skills' | 'relay'>;

  constructor(options: RuntimeOptions) {
    this.o = {
      poolSize: 4,
      leaseMs: 60_000,
      cancelGraceMs: 30_000,
      keepExecutions: 20,
      gateRetry: { initialMs: 1_000, maxMs: 300_000, maxAttempts: 8 },
      pdpTimeoutMs: 5_000,
      maxCheckpointBytes: 64 * 1024,
      ...options,
    };
    this.o.tasks.onCancelRequested((taskId) => {
      for (const [execId, r] of this.running)
        if (r.taskId === taskId) void this.cancelRunning(execId, r.controller);
    });
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
    const due = await this.store.transaction((tx) =>
      tx.find<StoredExecution>('executions', { where: { state: 'queued' } }),
    );
    let started = 0;
    for (const e of due) {
      if (started >= free) break;
      if (e.value.runAt > this.now() || this.running.has(e.id)) continue;
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
      const controller = new AbortController();
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      this.running.set(e.id, {
        done,
        release,
        controller,
        taskId: leased.task.id,
      });
      void this.execute(leased.exec, leased.task, controller).finally(() =>
        this.forget(e.id),
      );
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
    return this.store.transaction(async (tx) => {
      let renewed = 0;
      for (const id of ids) {
        const e = await tx.get<StoredExecution>('executions', id);
        if (!e || e.value.state !== 'running') continue;
        await tx.update<StoredExecution>('executions', id, e.revision, {
          ...e.value,
          leaseExpiresAt: addMs(this.now(), this.o.leaseMs),
        });
        renewed++;
      }
      return renewed;
    });
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
    try {
      const provider = this.o.implementations.get(
        t.snapshot.implementation.providerId,
        t.snapshot.implementation.providerVersion,
      );
      const agent = provider.createAgent(t.snapshot.implementation);
      const { checkpoint, wakeReason, causeTraceparent } =
        await this.resumeState(t.taskId, exec.value.trigger);
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
    await this.applyDisposition(exec, disposition).catch((err) => {
      // A fenced (stale-epoch) write is expected after lease loss or cancel grace expiry: the result is discarded.
      if (!isAgentropyError(err, 'StaleRevision')) throw err;
    });
  }

  private async resumeState(
    taskId: string,
    trigger: AgentInvocation['trigger'],
  ): Promise<{
    checkpoint?: unknown;
    wakeReason?: WakeReason;
    causeTraceparent?: string;
  }> {
    return this.store.transaction(async (tx) => {
      const cp = await tx.get<{ data: unknown }>('checkpoints', taskId);
      if (trigger !== 'resume') return { checkpoint: cp?.value.data };
      const fired = (
        await tx.find<WakeupRecord>('wakeups', {
          where: { taskId, status: 'fired' },
        })
      ).at(-1);
      return {
        checkpoint: cp?.value.data,
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
          });
        else
          await tx.insert('checkpoints', t.taskId, {
            taskId: t.taskId,
            data: d.checkpoint,
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
        const times = [
          ...conditionDue.filter((x): x is string => x !== null),
          ...(d.wakeup.timeoutAt ? [d.wakeup.timeoutAt] : []),
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

  /** Cooperative cancel: fire AbortSignal; if the handler has not returned after the grace period, fence it (E8 + T11). */
  private async cancelRunning(
    executionId: string,
    controller: AbortController,
  ): Promise<void> {
    controller.abort(
      new AgentropyError('TaskCancelled', 'Task cancellation requested'),
    );
    await new Promise((r) => setTimeout(r, this.o.cancelGraceMs));
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
