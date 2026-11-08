/**
 * User inbox as a projection of TaskEvents (docs/human-actions.md "User inbox as projection", R-12, R-25, R-36, AC-02).
 *
 * - `notification.notify` writes its journal entry and a `notificationCreated` outbox event in one transaction,
 *   so a replayed step returns the original `entryId` and never creates a second entry (AC-07 internal half).
 * - `InboxProjector` turns published events into entries; it is idempotent per event ID and never changes task state.
 * - `conversation.briefing` returns entries not yet presented at their current revision and marks them presented
 *   in the same transaction, so a later turn does not repeat an unchanged entry.
 */
import {
  AgentropyError,
  type CapabilityInvocationContext,
  type InboxEntry,
  type InboxMarker,
  type NotifyInput,
  type Severity,
  type StoreTx,
  type TrustedPrincipal,
} from '@agentropy/core';
import {
  toTaskEvent,
  type EventConsumer,
  type PublishedEvent,
} from './outbox.js';
import {
  SEVERITY_ORDER,
  resolveDelivery,
  type InboxPreferences,
  type PriorityPolicy,
} from './priority.js';
import {
  hashKey,
  type OutboxRecord,
  type TaskRecord,
  type TaskService,
} from './task-service.js';

export interface StoredInboxEntry extends InboxEntry {
  ownerId: string;
  status: 'open' | 'resolved';
  /** Recent source event IDs already applied (projection idempotency). */
  applied: string[];
  /**
   * 1 while the entry is neither acknowledged nor presented at its current revision, i.e. the briefing may show it.
   * Indexed; kept in step by `settle` on every write. Entries written before the field existed lack it.
   */
  pending?: 0 | 1;
}

/** The entry with `pending` recomputed from its markers and revision. */
const settle = (e: StoredInboxEntry): StoredInboxEntry => ({
  ...e,
  pending:
    !e.markers.acknowledgedAt && e.markers.presentedRevision !== e.revision
      ? 1
      : 0,
});

export interface EffectRecord {
  taskId: string;
  operation: string;
  stepKey?: string;
  result: unknown;
  at: string;
}

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'normal', 'low'];
const APPLIED_KEPT = 50;

/** Public shape: storage bookkeeping removed. */
export function publicEntry(e: StoredInboxEntry): InboxEntry {
  const { ownerId: _o, status: _s, applied: _a, pending: _p, ...entry } = e;
  void _o;
  void _s;
  void _a;
  void _p;
  return entry;
}

function authenticated(caller: TrustedPrincipal | undefined): TrustedPrincipal {
  if (!caller?.id || !caller.tenantId)
    throw new AgentropyError('Unauthenticated', 'No trusted principal');
  return caller;
}

export interface InboxServiceOptions {
  policy?: PriorityPolicy;
  preferences?: (
    user: TrustedPrincipal,
  ) => InboxPreferences | Promise<InboxPreferences>;
}

export class InboxService {
  constructor(
    private readonly tasks: TaskService,
    private readonly options: InboxServiceOptions = {},
  ) {}

  private get store() {
    return this.tasks.o.store;
  }

  async list(
    query: { cursor?: string; limit?: number },
    caller: TrustedPrincipal,
  ): Promise<{ entries: InboxEntry[]; cursor: string }> {
    const p = authenticated(caller);
    const after = query.cursor ? Number(query.cursor) : 0;
    if (!Number.isSafeInteger(after) || after < 0)
      throw new AgentropyError('SchemaViolation', 'Invalid inbox cursor');
    const docs = await this.store.transaction((tx) =>
      tx.find<StoredInboxEntry>('inbox', {
        where: { tenantId: p.tenantId, ownerId: p.id },
        orderBy: 'seq',
        afterSeq: after,
        limit: Math.min(Math.max(query.limit ?? 50, 1), 200),
      }),
    );
    return {
      entries: docs.map((d) => publicEntry(d.value)),
      cursor: String(docs.at(-1)?.seq ?? after),
    };
  }

  async mark(
    entryId: string,
    marker: InboxMarker,
    caller: TrustedPrincipal,
    presentedRevision?: number,
  ): Promise<void> {
    const p = authenticated(caller);
    await this.store.transaction(async (tx) => {
      const doc = await tx.get<StoredInboxEntry>('inbox', entryId);
      // Another user's or tenant's entry is invisible, not forbidden.
      if (
        !doc ||
        doc.value.ownerId !== p.id ||
        doc.value.tenantId !== p.tenantId
      )
        throw new AgentropyError('NotFound', 'Inbox entry not found');
      const e = doc.value;
      const now = this.tasks.o.now();
      const markers = { ...e.markers };
      if (marker === 'presented') {
        markers.presentedAt = now;
        markers.presentedRevision = presentedRevision ?? e.revision;
      } else if (marker === 'read') markers.readAt ??= now;
      else markers.acknowledgedAt ??= now;
      await tx.update<StoredInboxEntry>(
        'inbox',
        doc.id,
        doc.revision,
        settle({ ...e, markers }),
      );
    });
  }

  /**
   * Turn-start briefing (R-36, R-26): entries not yet presented at their current revision, filtered and ordered by
   * the delivery policy (interrupts first, then severity, then age), marked presented in the same transaction.
   * On-demand entries are left unpresented and only counted.
   */
  async briefing(
    user: TrustedPrincipal,
    limit = 10,
  ): Promise<{ entries: InboxEntry[]; onDemand: number }> {
    const p = authenticated(user);
    const prefs = (await this.options.preferences?.(p)) ?? {};
    return this.store.transaction(async (tx) => {
      // Only entries the briefing may show: `pending` 1, plus entries written before the field existed (null).
      const docs = (
        await Promise.all(
          [1, null].map((pending) =>
            tx.find<StoredInboxEntry>('inbox', {
              where: { tenantId: p.tenantId, ownerId: p.id, pending },
              orderBy: 'seq',
            }),
          ),
        )
      )
        .flat()
        .sort((x, y) => x.seq - y.seq);
      const due = docs
        .filter(
          (d) =>
            !d.value.markers.acknowledgedAt &&
            d.value.markers.presentedRevision !== d.value.revision,
        )
        .map((d) => ({
          d,
          decision: resolveDelivery(
            publicEntry(d.value),
            prefs,
            this.options.policy,
          ),
        }));
      const onDemand = due.filter((x) => x.decision.delivery === 'on-demand');
      const shown = due
        .filter((x) => x.decision.delivery !== 'on-demand')
        .sort(
          (a, b) =>
            Number(b.decision.delivery === 'interrupt') -
              Number(a.decision.delivery === 'interrupt') ||
            SEVERITY_ORDER.indexOf(a.decision.severity) -
              SEVERITY_ORDER.indexOf(b.decision.severity) ||
            a.d.seq - b.d.seq,
        )
        .slice(0, Math.min(Math.max(limit, 1), 50));
      const now = this.tasks.o.now();
      const entries: InboxEntry[] = [];
      for (const { d, decision } of shown) {
        const next: StoredInboxEntry = {
          ...d.value,
          markers: {
            ...d.value.markers,
            presentedAt: now,
            presentedRevision: d.value.revision,
          },
        };
        await tx.update<StoredInboxEntry>(
          'inbox',
          d.id,
          d.revision,
          settle(next),
        );
        entries.push({ ...publicEntry(next), severity: decision.severity });
      }
      return { entries, onDemand: onDemand.length };
    });
  }
}

/** Projects user-relevant TaskEvents into inbox entries. */
export class InboxProjector implements EventConsumer {
  readonly id = 'inbox';

  private readonly projectTerminal: (
    task: TaskRecord,
    type: 'taskCompleted' | 'taskFailed',
  ) => boolean;
  private touched: string[] = [];

  constructor(
    private readonly tasks: TaskService,
    options: {
      /** Which terminal task events become entries; default: failures of delegated (child) tasks. */
      projectTerminal?: (
        task: TaskRecord,
        type: 'taskCompleted' | 'taskFailed',
      ) => boolean;
      /** Urgent push to active clients (e.g. SSE); `true` marks the entry delivered. Durable replay stays the briefing. */
      push?: (entry: InboxEntry) => Promise<boolean>;
      policy?: PriorityPolicy;
    } = {},
  ) {
    this.projectTerminal =
      options.projectTerminal ??
      ((task, type) => type === 'taskFailed' && !!task.parentTaskId);
    this.push = options.push;
    this.policy = options.policy;
  }
  private readonly push?: (entry: InboxEntry) => Promise<boolean>;
  private readonly policy?: PriorityPolicy;

  /**
   * Reconciliation (M2-03): re-apply every committed TaskEvent in commit order. Projection is idempotent per event,
   * so existing entries and their markers are kept; missing entries are recreated. Task state is never changed.
   * Returns how many entries were created.
   */
  async rebuild(): Promise<number> {
    const store = this.tasks.o.store;
    const before = (await store.transaction((tx) => tx.find('inbox', {})))
      .length;
    const rows = await store.transaction((tx) =>
      tx.find<OutboxRecord>('outbox', { orderBy: 'seq' }),
    );
    for (const r of rows) await this.handle(toTaskEvent(r.value), false);
    return (
      (await store.transaction((tx) => tx.find('inbox', {}))).length - before
    );
  }

  async handle(event: PublishedEvent, push = true): Promise<void> {
    this.touched = [];
    await this.project(event);
    if (push && this.push) await this.pushUrgent(this.touched);
  }

  private async pushUrgent(ids: string[]): Promise<void> {
    for (const id of ids) {
      const doc = await this.tasks.o.store.transaction((tx) =>
        tx.get<StoredInboxEntry>('inbox', id),
      );
      if (!doc) continue;
      const entry = publicEntry(doc.value);
      if (resolveDelivery(entry, {}, this.policy).delivery !== 'interrupt')
        continue;
      let delivered = false;
      try {
        delivered = await this.push!(entry);
      } catch {
        delivered = false; // push is best effort; the briefing still presents it
      }
      if (delivered)
        await this.tasks.o.store.transaction(async (tx) => {
          const cur = await tx.get<StoredInboxEntry>('inbox', id);
          if (cur)
            await tx.update<StoredInboxEntry>('inbox', id, cur.revision, {
              ...cur.value,
              markers: {
                ...cur.value.markers,
                deliveredAt: this.tasks.o.now(),
              },
            });
        });
    }
  }

  private async project(event: PublishedEvent): Promise<void> {
    if (
      event.type !== 'notificationCreated' &&
      event.type !== 'humanActionRequested' &&
      event.type !== 'humanActionResolved' &&
      event.type !== 'taskCompleted' &&
      event.type !== 'taskFailed'
    )
      return;
    await this.tasks.o.store.transaction(async (tx) => {
      const task = (await tx.get<TaskRecord>('tasks', event.taskId))?.value;
      if (!task) return;
      switch (event.type) {
        case 'notificationCreated':
          return this.notification(tx, event, task);
        case 'humanActionRequested':
          return this.actionRequested(tx, event, task);
        case 'humanActionResolved':
          return this.actionResolved(tx, event);
        case 'taskCompleted':
        case 'taskFailed':
          if (this.projectTerminal(task, event.type))
            return this.upsert(tx, event, `entry:task:${task.taskId}`, {
              ownerId: task.ownerId,
              task,
              severity: 'high',
              title:
                event.type === 'taskFailed' ? 'Task failed' : 'Task completed',
              ...(task.outcome ? { body: task.outcome.message } : {}),
              sourceType: event.type,
            });
      }
    });
  }

  private async notification(
    tx: StoreTx,
    event: PublishedEvent,
    task: TaskRecord,
  ): Promise<void> {
    const d = event.data as NotifyInput & { entryId: string };
    await this.upsert(tx, event, d.entryId, {
      ownerId: task.ownerId,
      task,
      severity: d.severity,
      title: d.title,
      body: d.body,
      sourceType: 'notificationCreated',
    });
  }

  private async actionRequested(
    tx: StoreTx,
    event: PublishedEvent,
    task: TaskRecord,
  ): Promise<void> {
    const d = event.data as {
      requestId: string;
      prompt: string;
      assignees: { principalIds?: string[] };
    };
    const users = d.assignees.principalIds?.length
      ? d.assignees.principalIds
      : [task.ownerId];
    for (const user of users)
      await this.upsert(tx, event, actionEntryId(d.requestId, user), {
        ownerId: user,
        task,
        severity: 'high',
        title: d.prompt,
        actionRequestId: d.requestId,
        sourceType: 'humanActionRequested',
      });
  }

  private async actionResolved(
    tx: StoreTx,
    event: PublishedEvent,
  ): Promise<void> {
    const d = event.data as { requestId: string; assignees: string[] };
    for (const user of d.assignees) {
      const doc = await tx.get<StoredInboxEntry>(
        'inbox',
        actionEntryId(d.requestId, user),
      );
      if (!doc || doc.value.applied.includes(event.eventId)) continue;
      await tx.update<StoredInboxEntry>(
        'inbox',
        doc.id,
        doc.revision,
        settle({
          ...doc.value,
          status: 'resolved',
          revision: doc.value.revision + 1,
          markers: { ...doc.value.markers, resolvedAt: event.occurredAt },
          applied: [...doc.value.applied, event.eventId].slice(-APPLIED_KEPT),
        }),
      );
    }
  }

  private async upsert(
    tx: StoreTx,
    event: PublishedEvent,
    entryId: string,
    e: {
      ownerId: string;
      task: TaskRecord;
      severity: Severity;
      title: string;
      body?: string;
      actionRequestId?: string;
      sourceType: InboxEntry['source']['type'];
    },
  ): Promise<void> {
    const cur = await tx.get<StoredInboxEntry>('inbox', entryId);
    if (cur?.value.applied.includes(event.eventId)) return;
    this.touched.push(entryId);
    const content = {
      source: {
        eventId: event.eventId,
        taskId: event.taskId,
        type: e.sourceType,
      },
      severity: e.severity,
      title: e.title,
      ...(e.body !== undefined ? { body: e.body } : {}),
      ...(e.actionRequestId ? { actionRequestId: e.actionRequestId } : {}),
    };
    if (!cur) {
      await tx.insert<StoredInboxEntry>(
        'inbox',
        entryId,
        settle({
          entryId,
          userId: e.ownerId,
          ownerId: e.ownerId,
          tenantId: e.task.tenantId,
          agentInstanceId: e.task.instanceId,
          ...content,
          revision: 1,
          markers: {},
          status: 'open',
          applied: [event.eventId],
        }),
      );
      return;
    }
    // A later event for the same entry (deduplicated notification) revises it, so it is presented again.
    const { body: _b, ...previous } = cur.value;
    void _b;
    await tx.update<StoredInboxEntry>(
      'inbox',
      cur.id,
      cur.revision,
      settle({
        ...previous,
        ...content,
        revision: cur.value.revision + 1,
        applied: [...cur.value.applied, event.eventId].slice(-APPLIED_KEPT),
      }),
    );
  }
}

export const actionEntryId = (requestId: string, user: string) =>
  `entry:action:${hashKey(requestId, user)}`;

function validateNotify(input: unknown): NotifyInput {
  const n = input as Partial<NotifyInput> | null;
  if (
    !n ||
    !SEVERITIES.includes(n.severity as Severity) ||
    typeof n.title !== 'string' ||
    !n.title ||
    typeof n.body !== 'string' ||
    (n.dedupeKey !== undefined && typeof n.dedupeKey !== 'string')
  )
    throw new AgentropyError(
      'SchemaViolation',
      'notification.notify needs severity, title and body',
    );
  return {
    severity: n.severity!,
    title: n.title,
    body: n.body,
    ...(n.dedupeKey ? { dedupeKey: n.dedupeKey } : {}),
  };
}

/**
 * Platform-internal effect journal: runs `effect` at most once per idempotency key, in the same transaction
 * as the journal write, and returns the original result on replay.
 */
export async function journaled<T>(
  tasks: TaskService,
  ctx: CapabilityInvocationContext,
  operation: string,
  effect: (
    tx: StoreTx,
    task: { id: string; revision: number; value: TaskRecord },
  ) => Promise<T>,
): Promise<T> {
  if (!ctx.idempotencyKey)
    throw new AgentropyError(
      'SchemaViolation',
      `${operation} requires a stepKey`,
      {
        details: { reason: 'missingStepKey' },
      },
    );
  const effectId = `effect:${ctx.idempotencyKey}`;
  return tasks.o.store.transaction(async (tx) => {
    const done = await tx.get<EffectRecord>('effects', effectId);
    if (done) return done.value.result as T;
    const task = await tx.get<TaskRecord>('tasks', ctx.taskId);
    if (!task || task.value.tenantId !== ctx.tenantId)
      throw new AgentropyError('NotFound', 'Task not found');
    const result = await effect(tx, task);
    await tx.insert<EffectRecord>('effects', effectId, {
      taskId: ctx.taskId,
      operation,
      ...(ctx.stepKey ? { stepKey: ctx.stepKey } : {}),
      result,
      at: tasks.o.now(),
    });
    return result;
  });
}

/** Built-in `notification.notify` and `conversation.briefing` handlers. */
export function inboxOperationHandlers(
  tasks: TaskService,
  inbox: InboxService,
): Record<
  string,
  (input: unknown, ctx: CapabilityInvocationContext) => Promise<unknown>
> {
  return {
    notify: async (input, ctx) => {
      const n = validateNotify(input);
      return journaled(tasks, ctx, 'notification.notify', async (tx, task) => {
        const entryId = n.dedupeKey
          ? `entry:${hashKey(task.value.tenantId, task.value.ownerId, 'dedupe', n.dedupeKey)}`
          : `entry:${hashKey(ctx.idempotencyKey!)}`;
        await tasks.emit(tx, task.value, task.revision, 'notificationCreated', {
          ...n,
          entryId,
          ...(ctx.stepKey ? { stepKey: ctx.stepKey } : {}),
        });
        return { entryId };
      });
    },
    briefing: async (input, ctx) => {
      const { limit } = (input ?? {}) as { sessionId?: string; limit?: number };
      const task = await tasks.o.store.transaction((tx) =>
        tx.get<TaskRecord>('tasks', ctx.taskId),
      );
      if (!task || task.value.tenantId !== ctx.tenantId)
        throw new AgentropyError('NotFound', 'Task not found');
      // Only a turn the owner submitted may read the owner's inbox; a delegated turn from someone else may not.
      if (task.value.callerId !== task.value.ownerId)
        throw new AgentropyError(
          'PermissionDenied',
          'Briefing is only available to turns submitted by the inbox owner',
        );
      return inbox.briefing(
        { id: task.value.ownerId, type: 'user', tenantId: task.value.tenantId },
        limit,
      );
    },
  };
}
