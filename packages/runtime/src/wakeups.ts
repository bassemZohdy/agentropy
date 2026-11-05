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
} from '@agentropy/core';
import type { InstanceDirectory } from './registry.js';
import type { WakeupRecord } from './runtime.js';
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
}

export interface MailboxEntry {
  taskId: string;
  subscriptionId: string;
  eventId: string;
  payload: unknown;
  consumed: 0 | 1;
}

export interface HumanActionState {
  requestId: string;
  taskId: string;
  status: 'pending' | 'claimed' | 'resolved' | 'expired' | 'revoked';
  decisionInput?: unknown;
}

const matches = (
  filter: Record<string, unknown> | undefined,
  payload: unknown,
) =>
  !filter ||
  Object.entries(filter).every(
    ([k, v]) => (payload as Record<string, unknown> | null)?.[k] === v,
  );

export class WakeupService {
  constructor(
    private readonly tasks: TaskService,
    private readonly instances: InstanceDirectory,
  ) {}

  private get store() {
    return this.tasks.o.store;
  }
  private now() {
    return this.tasks.o.now();
  }

  /** Evaluate every armed registration once; returns how many fired. Safe to call repeatedly and concurrently. */
  async poll(): Promise<number> {
    const armed = await this.store.transaction((tx) =>
      tx.find<WakeupRecord>('wakeups', { where: { status: 'armed' } }),
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
      if (!(await tx.get('subscriptions', id)))
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
  }): Promise<boolean> {
    const fresh = await this.store.transaction(async (tx) => {
      if (await tx.get('inboundEvents', event.eventId)) return false;
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
        await tx.insert<MailboxEntry>('mailbox', `${s.id}:${event.eventId}`, {
          taskId: s.value.taskId,
          subscriptionId: s.id,
          eventId: event.eventId,
          payload: event.payload,
          consumed: 0,
        });
      }
      return true;
    });
    if (fresh) await this.poll();
    return fresh;
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
      const hit = await this.evaluate(tx, w.value, now);
      if (!hit) return false;
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
        const req = await tx.get<HumanActionState>('humanActions', c.requestId);
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
        const children = await Promise.all(
          c.taskIds.map((id) => tx.get<TaskRecord>('tasks', id)),
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
  return {
    delegate: async (input, ctx) => {
      const d = input as DelegateInput;
      const parent = await tasks.o.store.transaction((tx) =>
        tx.get<TaskRecord>('tasks', ctx.taskId),
      );
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
      );
    },
    getTask: async (input, ctx): Promise<TaskSnapshot> => {
      const doc = await ownChild((input as { taskId: string }).taskId, ctx);
      return toSnapshot(doc.value, doc.revision);
    },
    cancel: async (input, ctx) => {
      const { taskId, reason } = input as { taskId: string; reason?: string };
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
