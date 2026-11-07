/**
 * Wake-ups (M1-08, ADR-0017): polling scheduler over armed registrations, in-process event bus with durable
 * per-task subscriptions and mailboxes, child-task and human-action wake-ups. Firing consumes a registration
 * with a CAS (exactly-once consumption, at-least-once delivery) and applies T5 (or T9 on fail-timeout).
 */
import {
  AgentropyError,
  CAPABILITY_CATALOG,
  digestOf,
  isTerminal,
  nextOccurrence,
  TASK_MACHINE,
  type CapabilityInvocationContext,
  type CapabilityProvider,
  type DelegateInput,
  type StoreTx,
  type StoredDocument,
  type TaskSnapshot,
  type TrustedPrincipal,
  type WakeReason,
  METRICS,
  sanitizeTraceparent,
} from '@agentropy/core';
import { compactStore, type CompactionResult } from './compaction.js';
import type { StoredHumanAction } from './human-actions.js';
import { DEFAULT_LIMITS, assertMaxBytes } from './limits.js';
import type { InstanceDirectory } from './registry.js';
import type { RemoteDelegationService, RemoteTaskRecord } from './remote.js';
import type { WakeupRecord } from './runtime.js';
import { pokeWakeups } from './wake-index.js';
import {
  toSnapshot,
  type TaskRecord,
  type TaskService,
} from './task-service.js';

export interface Subscription {
  id: string;
  taskId: string;
  tenantId: string;
  source: string;
  filter?: Record<string, unknown>;
  status: 'active' | 'revoked';
  /** Events not appended because the mailbox was full (back-pressure). */
  dropped?: number;
  lastDroppedEventId?: string;
}

export interface MailboxEntry {
  taskId: string;
  subscriptionId: string;
  eventId: string;
  payload: unknown;
  consumed: 0 | 1;
  /** Sanitized W3C traceparent the producer sent with the event (correlation only). */
  traceparent?: string;
}

const matches = (
  filter: Record<string, unknown> | undefined,
  payload: unknown,
) =>
  !filter ||
  Object.entries(filter).every(
    ([k, v]) => (payload as Record<string, unknown> | null)?.[k] === v,
  );

export interface WakeupServiceOptions {
  /** Unconsumed events kept per subscription; further events are dropped and counted (default 1000). */
  mailboxLimit?: number;
  /** Largest inbound event payload (default `DEFAULT_LIMITS.maxEventBytes`); larger is `SchemaViolation`. */
  maxEventBytes?: number;
  /**
   * A poll evaluates only registrations due by `checkAt` (FEAT-033.2); every `fullScanMs` (default 60 s, and on
   * the first poll) it evaluates every armed registration instead, as a backstop.
   */
  fullScanMs?: number;
}

export interface OfferResult {
  /** False for a duplicate inbound event ID (already recorded). */
  accepted: boolean;
  /** Subscriptions the event was appended to. */
  appended: number;
  /** Subscriptions whose mailbox was full (back-pressure: the event was not appended there). */
  dropped: number;
}

export class WakeupService {
  private readonly sweeps: (() => Promise<unknown>)[] = [];
  private lastFullScan = -Infinity;

  constructor(
    private readonly tasks: TaskService,
    private readonly instances: InstanceDirectory,
    private readonly options: WakeupServiceOptions = {},
  ) {}

  /** Work run at the start of every poll, e.g. human-action expiry, so due state changes are seen by this poll. */
  addSweep(sweep: () => Promise<unknown>): void {
    this.sweeps.push(sweep);
  }

  private get store() {
    return this.tasks.o.store;
  }
  private now() {
    return this.tasks.o.now();
  }

  /** Evaluate every armed registration once; returns how many fired. Safe to call repeatedly and concurrently. */
  async poll(options: { sweeps?: boolean } = {}): Promise<number> {
    if (options.sweeps !== false)
      for (const sweep of this.sweeps) await sweep();
    const now = this.now();
    const at = Date.parse(now);
    const full = at - this.lastFullScan >= (this.options.fullScanMs ?? 60_000);
    if (full) this.lastFullScan = at;
    const armed = await this.store.transaction((tx) =>
      tx.find<WakeupRecord>('wakeups', {
        where: { status: 'armed' },
        ...(full ? {} : { range: { field: 'checkAt', lte: now } }),
      }),
    );
    let fired = 0;
    for (const w of armed) if (await this.tryFire(w.id)) fired++;
    return fired;
  }

  /** Durable subscription for a task; deterministic ID makes replays idempotent. */
  async subscribe(
    taskId: string,
    tenantId: string,
    source: string,
    filter?: Record<string, unknown>,
  ): Promise<string> {
    const id = `sub:${digestOf({ taskId, source, filter: filter ?? null })}`;
    await this.store.transaction(async (tx) => {
      const existing = await tx.get<Subscription>('subscriptions', id);
      // One that `unsubscribe` revoked is active again: the deterministic ID must not leave it dead (FEAT-038.2).
      if (existing?.value.status === 'revoked')
        await tx.update<Subscription>('subscriptions', id, existing.revision, {
          ...existing.value,
          status: 'active',
        });
      else if (!existing)
        await tx.insert<Subscription>('subscriptions', id, {
          id,
          taskId,
          tenantId,
          source,
          ...(filter ? { filter } : {}),
          status: 'active',
        });
    });
    return id;
  }

  async unsubscribe(subscriptionId: string, taskId: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const s = await tx.get<Subscription>('subscriptions', subscriptionId);
      if (s && s.value.taskId === taskId && s.value.status === 'active')
        await tx.update('subscriptions', s.id, s.revision, {
          ...s.value,
          status: 'revoked',
        });
    });
  }

  /**
   * Record an inbound event and append it to every matching active subscription's mailbox in one transaction.
   * A duplicate event ID is dropped at append time. Returns false for a duplicate.
   */
  async publish(event: {
    eventId: string;
    source: string;
    tenantId: string;
    payload: unknown;
    traceparent?: string;
  }): Promise<boolean> {
    return (await this.offer(event)).accepted;
  }

  /**
   * `publish` with back-pressure detail (M2-01): a subscription whose mailbox already holds `mailboxLimit`
   * unconsumed events does not receive the event; the drop is counted on the subscription.
   */
  async offer(event: {
    eventId: string;
    source: string;
    tenantId: string;
    payload: unknown;
    traceparent?: string;
  }): Promise<OfferResult> {
    const limit = this.options.mailboxLimit ?? 1000;
    assertMaxBytes(
      event.payload,
      this.options.maxEventBytes ?? DEFAULT_LIMITS.maxEventBytes,
      'event',
    );
    const telemetry = this.tasks.telemetry;
    const traceparent = sanitizeTraceparent(event.traceparent);
    if (event.traceparent !== undefined && !traceparent)
      telemetry.count(METRICS.traceRejected, 1, { carrier: 'event' });
    const result = await this.store.transaction(async (tx) => {
      const r: OfferResult = { accepted: false, appended: 0, dropped: 0 };
      if (await tx.get('inboundEvents', event.eventId)) return r;
      r.accepted = true;
      await tx.insert('inboundEvents', event.eventId, {
        source: event.source,
        tenantId: event.tenantId,
        at: this.now(),
      });
      for (const s of await tx.find<Subscription>('subscriptions', {
        where: { source: event.source, status: 'active' },
      })) {
        if (
          s.value.tenantId !== event.tenantId ||
          !matches(s.value.filter, event.payload)
        )
          continue;
        // Only whether the mailbox is full matters: read at most `limit` rows.
        const pending = await tx.find<MailboxEntry>('mailbox', {
          where: { subscriptionId: s.id, consumed: 0 },
          limit,
        });
        if (pending.length >= limit) {
          await tx.update<Subscription>('subscriptions', s.id, s.revision, {
            ...s.value,
            dropped: (s.value.dropped ?? 0) + 1,
            lastDroppedEventId: event.eventId,
          });
          r.dropped++;
          telemetry.count(METRICS.mailboxDropped, 1, {
            'agentropy.event.source': event.source,
          });
          continue;
        }
        await tx.insert<MailboxEntry>('mailbox', `${s.id}:${event.eventId}`, {
          taskId: s.value.taskId,
          subscriptionId: s.id,
          eventId: event.eventId,
          payload: event.payload,
          consumed: 0,
          ...(traceparent ? { traceparent } : {}),
        });
        await pokeWakeups(tx, s.value.taskId, this.now());
        r.appended++;
      }
      return r;
    });
    // The event poked the registrations it concerns: evaluate those (the due-time index), not every sweep again.
    if (result.accepted) await this.poll({ sweeps: false });
    return result;
  }

  /**
   * Compaction (M2-01, R-37; every collection since FEAT-040.1): see `compactStore`. Duplicate inbound events are
   * only detected inside the retention window.
   */
  compact(retainMs: number): Promise<CompactionResult> {
    return compactStore(this.tasks, retainMs);
  }

  private async tryFire(wakeupId: string): Promise<boolean> {
    return this.store.transaction(async (tx) => {
      const w = await tx.get<WakeupRecord>('wakeups', wakeupId);
      if (!w || w.value.status !== 'armed') return false;
      const task = await tx.get<TaskRecord>('tasks', w.value.taskId);
      if (!task || task.value.status !== 'waiting') return false;
      // A suspended instance defers its wake-ups (they fire after resume), never drops them.
      if (
        (await tx.get<{ state: string }>('instances', task.value.instanceId))
          ?.value.state === 'suspended'
      )
        return false;
      const now = this.now();
      // T9: a waiting task past its deadline fails, whatever it waits for (FEAT-038.1).
      if (task.value.deadline && task.value.deadline <= now) {
        await this.tasks.terminate(tx, task, 'failed', 'T9', {
          code: 'Timeout',
          message: 'Task deadline passed',
        });
        return true;
      }
      const hit = await this.evaluate(tx, w.value, now);
      if (!hit) {
        // Nothing holds yet: wait for the next due time or a poke.
        if (w.value.checkAt !== w.value.dueAt)
          await tx.update<WakeupRecord>('wakeups', w.id, w.revision, {
            ...w.value,
            checkAt: w.value.dueAt,
          });
        return false;
      }
      // The activation budget (`budget.maxActivations`) is spent: no further activation, T9 (FEAT-038.1).
      const maxActivations = task.value.budget?.maxActivations;
      if (
        maxActivations !== undefined &&
        task.value.activation >= maxActivations
      ) {
        await tx.update<WakeupRecord>('wakeups', w.id, w.revision, {
          ...w.value,
          status: 'fired',
          reason: hit.reason,
        });
        await this.tasks.terminate(tx, task, 'failed', 'T9', {
          code: 'BudgetExceeded',
          message: 'Activation budget spent',
        });
        return true;
      }
      // An expired human action whose request says fail-task fails the task (T9) instead of resuming it.
      if (
        hit.reason.kind === 'human-action' &&
        hit.reason.outcome === 'expired' &&
        (await tx.get<StoredHumanAction>('humanActions', hit.reason.requestId))
          ?.value.onExpiry === 'fail-task'
      ) {
        await tx.update<WakeupRecord>('wakeups', w.id, w.revision, {
          ...w.value,
          status: 'fired',
          reason: hit.reason,
        });
        await this.tasks.terminate(tx, task, 'failed', 'T9', {
          code: 'ActionExpired',
          message: 'Human action expired',
        });
        return true;
      }
      if (hit.reason.kind === 'timeout' && w.value.onTimeout === 'fail') {
        await tx.update<WakeupRecord>('wakeups', w.id, w.revision, {
          ...w.value,
          status: 'fired',
          reason: hit.reason,
        });
        await this.tasks.terminate(tx, task, 'failed', 'T9', {
          code: 'Timeout',
          message: 'Wake-up timeout elapsed',
        });
        return true;
      }
      await tx.update<WakeupRecord>('wakeups', w.id, w.revision, {
        ...w.value,
        status: 'fired',
        reason: hit.reason,
        ...(hit.consume?.value.traceparent
          ? { causeTraceparent: hit.consume.value.traceparent }
          : {}),
      });
      if (hit.consume)
        await tx.update<MailboxEntry>(
          'mailbox',
          hit.consume.id,
          hit.consume.revision,
          { ...hit.consume.value, consumed: 1 },
        );
      const { waitingOn: _w, ...rest } = task.value;
      void _w;
      const next = await this.tasks.transition(
        tx,
        { ...task, value: rest as TaskRecord },
        'assigned',
        'T5',
        { activation: task.value.activation + 1, attempt: 1 },
      );
      await this.tasks.queueExecution(
        tx,
        task.id,
        next.value.activation,
        1,
        'resume',
        now,
      );
      return true;
    });
  }

  /** First condition that is satisfied, in declaration order; the timeout is checked last. */
  private async evaluate(
    tx: StoreTx,
    w: WakeupRecord,
    now: string,
  ): Promise<
    { reason: WakeReason; consume?: StoredDocument<MailboxEntry> } | undefined
  > {
    for (const [i, c] of w.conditions.entries()) {
      if (c.kind === 'timer' || c.kind === 'schedule') {
        const due = w.conditionDue?.[i];
        if (due && due <= now)
          return { reason: { kind: c.kind, firedAt: now } };
      } else if (c.kind === 'event') {
        const pending = await tx.find<MailboxEntry>('mailbox', {
          where: { subscriptionId: c.subscription, consumed: 0 },
          limit: 1,
        });
        const oldest = pending[0];
        if (oldest)
          return {
            reason: {
              kind: 'event',
              subscription: c.subscription,
              eventId: oldest.value.eventId,
              payload: oldest.value.payload,
            },
            consume: oldest,
          };
      } else if (c.kind === 'human-action') {
        const req = await tx.get<StoredHumanAction>(
          'humanActions',
          c.requestId,
        );
        const s = req?.value.status;
        if (s === 'resolved' || s === 'expired' || s === 'revoked') {
          return {
            reason: {
              kind: 'human-action',
              requestId: c.requestId,
              outcome: s,
              ...(s === 'resolved' ? { input: req!.value.decisionInput } : {}),
            },
          };
        }
      } else if (c.kind === 'child-tasks') {
        // Remote children (FEAT-027.9) are tracked by their local projection, found by its indexed task ID.
        const children = await Promise.all(
          c.taskIds.map(async (id) => {
            const local = await tx.get<TaskRecord>('tasks', id);
            if (local) return local;
            if (!id.includes(':')) return undefined;
            const r = (
              await tx.find<RemoteTaskRecord>('remoteTasks', {
                where: { taskId: id },
              })
            )[0];
            return r
              ? ({
                  ...r,
                  id,
                  value: r.value as unknown as TaskRecord,
                } as StoredDocument<TaskRecord>)
              : undefined;
          }),
        );
        const done = children.filter(
          (d): d is StoredDocument<TaskRecord> =>
            !!d && isTerminal(TASK_MACHINE, d.value.status),
        );
        if (
          c.mode === 'all' ? done.length === c.taskIds.length : done.length > 0
        ) {
          return {
            reason: {
              kind: 'child-tasks',
              children: done.map((d) => ({
                taskId: d.id,
                status: d.value.status as 'completed' | 'failed' | 'cancelled',
                ...(d.value.status === 'completed'
                  ? { output: d.value.output }
                  : { outcome: d.value.outcome }),
              })),
            },
          };
        }
      }
    }
    if (w.timeoutAt && w.timeoutAt <= now)
      return { reason: { kind: 'timeout' } };
    return undefined;
  }
}

export type OperationHandler = (
  input: unknown,
  ctx: CapabilityInvocationContext,
) => Promise<unknown>;

/**
 * Built-in capability provider: routes `operation` to the handler of the capability that declares it.
 * Capability v1 operation names are unique across the catalog, which this constructor asserts.
 */
export class BuiltinCapabilityProvider implements CapabilityProvider {
  readonly id = 'builtin';
  readonly version = '1.0.0';
  readonly contracts = CAPABILITY_CATALOG.map((c) => ({
    id: c.id,
    version: c.version,
    ...(c.id === 'durability' ? { level: 'durable-execution' } : {}),
  }));
  private readonly handlers = new Map<string, OperationHandler>();

  constructor(handlers: Partial<Record<string, OperationHandler>>) {
    const owners = new Map<string, string>();
    for (const c of CAPABILITY_CATALOG)
      for (const op of c.operations) {
        if (owners.has(op.name))
          throw new AgentropyError(
            'Internal',
            `Operation ${op.name} is declared twice`,
          );
        owners.set(op.name, c.id);
      }
    for (const [op, h] of Object.entries(handlers))
      if (h) this.handlers.set(op, h);
  }

  async invoke<I, O>(
    operation: string,
    input: I,
    ctx: CapabilityInvocationContext,
  ): Promise<O> {
    const h = this.handlers.get(operation);
    if (!h)
      throw new AgentropyError(
        'UnsupportedOperation',
        `No built-in implementation for ${operation}`,
        { details: { operation } },
      );
    return (await h(input, ctx)) as O;
  }
}

/** Handlers for delegation, event-handling and scheduling operations (Capability v1 operation I/O). */
export function coreOperationHandlers(
  tasks: TaskService,
  wakeups: WakeupService,
  remote?: RemoteDelegationService,
): Record<string, OperationHandler> {
  const agentPrincipal = async (
    ctx: CapabilityInvocationContext,
  ): Promise<TrustedPrincipal> => ({
    id: ctx.principalId,
    type: 'agent',
    tenantId: ctx.tenantId,
    ...(ctx.delegatedAuthorityRef
      ? { delegatedAuthorityRef: ctx.delegatedAuthorityRef }
      : {}),
  });
  const ownChild = async (
    taskId: string,
    ctx: CapabilityInvocationContext,
  ): Promise<StoredDocument<TaskRecord>> => {
    const doc = await tasks.o.store.transaction((tx) =>
      tx.get<TaskRecord>('tasks', taskId),
    );
    if (
      !doc ||
      doc.value.parentTaskId !== ctx.taskId ||
      doc.value.tenantId !== ctx.tenantId
    )
      throw new AgentropyError('NotFound', 'Task not found');
    return doc;
  };
  const remoteChild = async (
    taskId: string,
    ctx: CapabilityInvocationContext,
  ): Promise<RemoteTaskRecord | undefined> => {
    if (!remote || !taskId.includes(':')) return undefined;
    try {
      const r = await remote.get(taskId, await agentPrincipal(ctx));
      return r.parentTaskId === ctx.taskId ? r : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    delegate: async (input, ctx) => {
      const d = input as DelegateInput;
      const parent = await tasks.o.store.transaction((tx) =>
        tx.get<TaskRecord>('tasks', ctx.taskId),
      );
      if (d.target?.remote) {
        if (!remote)
          throw new AgentropyError(
            'NoCompatibleRoute',
            'No communication router is configured for remote targets',
          );
        if (!ctx.idempotencyKey)
          throw new AgentropyError(
            'SchemaViolation',
            'delegate requires a stepKey',
            {
              details: { reason: 'missingStepKey' },
            },
          );
        return remote.delegate(
          {
            target: d.target,
            input: d.input,
            idempotencyKey: ctx.idempotencyKey,
            correlationId: parent?.value.correlationId ?? ctx.taskId,
            parentTaskId: ctx.taskId,
            ...(d.deadline ? { deadline: d.deadline } : {}),
          },
          await agentPrincipal(ctx),
        );
      }
      return tasks.delegate(
        {
          target: d.target,
          input: d.input,
          idempotencyKey: ctx.idempotencyKey!,
          correlationId: parent?.value.correlationId ?? ctx.taskId,
          parentTaskId: ctx.taskId,
          ...(d.deadline ? { deadline: d.deadline } : {}),
          ...(d.budget ? { budget: d.budget } : {}),
        },
        await agentPrincipal(ctx),
        ctx.traceparent ? { traceparent: ctx.traceparent } : {},
      );
    },
    getTask: async (input, ctx): Promise<TaskSnapshot> => {
      const { taskId } = input as { taskId: string };
      const r = remote ? await remoteChild(taskId, ctx) : undefined;
      if (r) return remote!.snapshot(r);
      const doc = await ownChild(taskId, ctx);
      return toSnapshot(doc.value, doc.revision);
    },
    cancel: async (input, ctx) => {
      const { taskId, reason } = input as { taskId: string; reason?: string };
      const r = remote ? await remoteChild(taskId, ctx) : undefined;
      if (r) return remote!.cancel(taskId, await agentPrincipal(ctx));
      await ownChild(taskId, ctx);
      return tasks.cancel(taskId, await agentPrincipal(ctx), reason);
    },
    subscribe: async (input, ctx) => {
      const { source, filter } = input as {
        source: string;
        filter?: Record<string, unknown>;
      };
      return {
        subscription: await wakeups.subscribe(
          ctx.taskId,
          ctx.tenantId,
          source,
          filter,
        ),
      };
    },
    unsubscribe: async (input, ctx) => {
      await wakeups.unsubscribe(
        (input as { subscription: string }).subscription,
        ctx.taskId,
      );
      return {};
    },
    nextOccurrence: async (input) => {
      const { cron, timezone, after } = input as {
        cron: string;
        timezone: string;
        after?: string;
      };
      return { at: nextOccurrence(cron, timezone, after ?? tasks.o.now()) };
    },
  };
}
