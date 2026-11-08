/**
 * Outbox relay and TaskEvent streams (messaging contract "Publication and inbox reconciliation", R-29, AC-19).
 *
 * Transitions and their outbox rows commit together (TaskService). The relay leases nothing: it reads unpublished
 * rows in commit order, hands each to every consumer and only then marks it published. A crash anywhere before
 * the mark re-delivers the row after restart, so delivery is at-least-once and consumers deduplicate by event ID
 * (or by the `(revision, sequence)` pair). No external exactly-once is claimed.
 *
 * With a leader lease (`relayId`, several workers on one store) only the leader delivers to `consumers` and marks
 * rows published. `localConsumers` (in-process signals such as subscription wake-ups) are fed by every relay,
 * leader or not, by following the outbox in seq order after a cursor; seq order is commit order, so the cursor
 * never skips a row (FEAT-032.5).
 */
import {
  isAfter,
  type Store,
  type TaskEvent,
  type TrustedPrincipal,
  TASK_MACHINE,
  isTerminal,
  METRICS,
  type Telemetry,
} from '@agentropy/core';
import type { OutboxRecord, TaskService } from './task-service.js';

/** A published TaskEvent with routing context for consumers. */
export interface PublishedEvent extends TaskEvent {
  tenantId: string;
  correlationId: string;
}

export interface EventConsumer {
  readonly id: string;
  /** Must be idempotent per `eventId`: the relay re-delivers after a crash before the published mark. */
  handle(event: PublishedEvent): Promise<void>;
}

/** Structural fault hook (the testkit FaultInjector satisfies it); production passes nothing. */
export interface FaultHook {
  checkpoint(operation: string): void;
}

export function toTaskEvent(r: OutboxRecord): PublishedEvent {
  return {
    eventId: r.eventId,
    taskId: r.aggregateId,
    revision: r.revision,
    sequence: r.sequence,
    type: r.type,
    status: r.status,
    occurredAt: r.occurredAt,
    ...(r.data !== undefined ? { data: r.data } : {}),
    tenantId: r.tenantId,
    correlationId: r.correlationId,
  };
}

export interface OutboxRelayOptions {
  store: Store;
  consumers?: EventConsumer[];
  /** Rows handled per drain call (bounded work per tick). */
  batchSize?: number;
  faults?: FaultHook;
  /**
   * Relay identity for the leader lease (M2-06): with several relays on one store only the lease holder
   * delivers, so per-task order holds; a crashed holder's lease expires and another relay replays its rows.
   */
  relayId?: string;
  /**
   * Consumers every relay feeds, leader or not (in-process signals; must not have shared side effects). Without
   * `relayId` they are fed together with `consumers`.
   */
  localConsumers?: EventConsumer[];
  /** Leader lease length (default 30 s). */
  leaseMs?: number;
  /**
   * Off by default: a row that keeps failing holds back every later row (ordering is kept). With a number, a row
   * whose delivery failed that many times is given up on: marked published and `poisoned` (counted as
   * `agentropy.outbox.poisoned`) so delivery goes on. A consumer that missed it is repaired by reconciliation
   * (`rebuildInbox` for the inbox); other consumers must be able to tolerate a gap.
   */
  poisonAfter?: number;
  /** Delivery lag and terminal-outcome metrics, recorded once per published row. */
  telemetry?: Telemetry;
  now?: () => string;
}

export class OutboxRelay {
  private readonly consumers: EventConsumer[];
  private readonly local: EventConsumer[];
  private draining?: Promise<number>;
  /** Seq of the last row handed to local consumers (lease mode); `undefined` until the first follow. */
  private cursor: number | undefined;

  constructor(private readonly o: OutboxRelayOptions) {
    this.local = [...(o.localConsumers ?? [])];
    // Without a lease this relay is the only one: local consumers ride along with the shared ones.
    this.consumers = [...(o.consumers ?? []), ...(o.relayId ? [] : this.local)];
  }

  register(consumer: EventConsumer): void {
    if (this.consumers.some((c) => c.id === consumer.id))
      throw new RangeError(`Consumer ${consumer.id} is already registered`);
    this.consumers.push(consumer);
  }

  private observe(r: OutboxRecord): void {
    const t = this.o.telemetry;
    if (!t) return;
    if (this.o.now)
      t.record(
        METRICS.outboxLag,
        Math.max(0, Date.parse(this.o.now()) - Date.parse(r.occurredAt)),
        { 'agentropy.event.type': r.type },
      );
    if (r.sequence === 0 && isTerminal(TASK_MACHINE, r.status))
      t.count(METRICS.tasksFinished, 1, {
        'agentropy.task.status': r.status,
        ...(r.payload.outcome
          ? { 'agentropy.outcome.code': r.payload.outcome.code }
          : {}),
      });
  }

  /**
   * Rows that consumers keep failing on (`attempts` at or above `minAttempts`). Delivery is in order, so the oldest
   * of them holds back every later row: this is what an operator or a readiness probe looks at (FEAT-039.4).
   */
  async stuck(minAttempts = 5): Promise<
    {
      eventId: string;
      attempts: number;
      occurredAt: string;
      lastError?: string;
    }[]
  > {
    const rows = await this.o.store.transaction((tx) =>
      tx.find<OutboxRecord>('outbox', {
        where: { published: 0 },
        orderBy: 'seq',
        limit: 100,
      }),
    );
    return rows
      .filter((r) => r.value.attempts >= minAttempts)
      .map((r) => ({
        eventId: r.value.eventId,
        attempts: r.value.attempts,
        occurredAt: r.value.occurredAt,
        ...(r.value.lastError ? { lastError: r.value.lastError } : {}),
      }));
  }

  /** Publish pending rows in commit order; stops at the first failing row so order is preserved. Returns rows published. */
  drain(): Promise<number> {
    // One drain at a time per relay keeps per-relay order; concurrent callers share the running drain.
    this.draining ??= this.drainOnce().finally(
      () => (this.draining = undefined),
    );
    return this.draining;
  }

  /** Acquire or renew the relay leader lease; false while another relay holds a live lease. */
  private async lead(): Promise<boolean> {
    if (!this.o.relayId) return true;
    const now = this.o.now?.() ?? new Date().toISOString();
    const until = new Date(
      Date.parse(now) + (this.o.leaseMs ?? 30_000),
    ).toISOString();
    return this.o.store.transaction(async (tx) => {
      const cur = await tx.get<{
        kind: string;
        holder: string;
        expiresAt: string;
      }>('leases', 'outbox-relay');
      if (!cur) {
        await tx.insert('leases', 'outbox-relay', {
          kind: 'relay',
          holder: this.o.relayId!,
          expiresAt: until,
        });
        return true;
      }
      if (cur.value.holder !== this.o.relayId && cur.value.expiresAt > now)
        return false;
      await tx.update('leases', cur.id, cur.revision, {
        kind: 'relay',
        holder: this.o.relayId!,
        expiresAt: until,
      });
      return true;
    });
  }

  private async drainOnce(): Promise<number> {
    const published = (await this.lead()) ? await this.publish() : 0;
    if (this.o.relayId && this.local.length) await this.follow();
    return published;
  }

  /** Hands every committed row after the cursor to the local consumers, published or not. */
  private async follow(): Promise<void> {
    const limit = this.o.batchSize ?? 100;
    // A process that has just started has no subscribers yet: start at the newest row, not at the first one ever
    // written (FEAT-039.4). Subscriptions replay from the outbox themselves.
    this.cursor ??=
      (
        await this.o.store.transaction((tx) =>
          tx.find<OutboxRecord>('outbox', {
            orderBy: 'seq',
            descending: true,
            limit: 1,
          }),
        )
      )[0]?.seq ?? 0;
    for (;;) {
      const rows = await this.o.store.transaction((tx) =>
        tx.find<OutboxRecord>('outbox', {
          afterSeq: this.cursor!,
          orderBy: 'seq',
          limit,
        }),
      );
      for (const row of rows) {
        const event = toTaskEvent(row.value);
        for (const c of this.local)
          await c.handle(event).catch(() => undefined);
        this.cursor = row.seq;
      }
      if (rows.length < limit) return;
    }
  }

  private async publish(): Promise<number> {
    let published = 0;
    for (;;) {
      const pending = await this.o.store.transaction((tx) =>
        tx.find<OutboxRecord>('outbox', {
          where: { published: 0 },
          orderBy: 'seq',
          limit: this.o.batchSize ?? 100,
        }),
      );
      if (!pending.length) return published;
      for (const row of pending) {
        const event = toTaskEvent(row.value);
        try {
          this.o.faults?.checkpoint('relay.deliver');
          for (const c of this.consumers) await c.handle(event);
          this.o.faults?.checkpoint('relay.markPublished');
          this.observe(row.value);
        } catch (err) {
          this.o.telemetry?.count(METRICS.outboxFailures, 1, {
            'agentropy.event.type': row.value.type,
          });
          const poisoned = await this.o.store.transaction(async (tx) => {
            const cur = await tx.get<OutboxRecord>('outbox', row.id);
            if (!cur || cur.value.published !== 0) return false;
            const attempts = cur.value.attempts + 1;
            const give =
              this.o.poisonAfter !== undefined &&
              attempts >= this.o.poisonAfter;
            await tx.update<OutboxRecord>('outbox', cur.id, cur.revision, {
              ...cur.value,
              attempts,
              lastError: err instanceof Error ? err.name : 'Error',
              ...(give ? { published: 1 as const, poisoned: true } : {}),
            });
            return give;
          });
          if (poisoned) {
            this.o.telemetry?.count(METRICS.outboxPoisoned, 1, {
              'agentropy.event.type': row.value.type,
            });
            published++;
            continue; // given up on: the next row is delivered
          }
          return published;
        }
        await this.o.store.transaction(async (tx) => {
          const cur = await tx.get<OutboxRecord>('outbox', row.id);
          if (cur && cur.value.published === 0)
            await tx.update<OutboxRecord>('outbox', cur.id, cur.revision, {
              ...cur.value,
              published: 1,
            });
        });
        published++;
      }
    }
  }
}

/**
 * Live TaskEvent fan-out for `AgentService.subscribe`: replays committed events from the outbox, then follows
 * relay deliveries. Duplicates and replays at or below the last seen `(revision, sequence)` are dropped (AC-17).
 */
export class TaskEventStream implements EventConsumer {
  readonly id = 'task-event-stream';
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly tasks: TaskService) {}

  async handle(event: PublishedEvent): Promise<void> {
    for (const wake of this.listeners.get(event.taskId) ?? []) wake();
  }

  /**
   * Events of one visible task after `from`, ending after its terminal event, or as soon as `abort` fires (the
   * subscription is released at once, not at the task's next event).
   */
  async *subscribe(
    taskId: string,
    caller: TrustedPrincipal,
    from?: { revision: number; sequence: number },
    abort?: AbortSignal,
  ): AsyncIterable<TaskEvent> {
    await this.tasks.visible(taskId, caller);
    const aborted = new Promise<void>((r) => {
      if (abort?.aborted) r();
      else abort?.addEventListener('abort', () => r(), { once: true });
    });
    let last = from;
    let signal = this.signal(taskId);
    // Each pass reads only the rows committed since the previous one (by seq), not the task's whole history.
    let afterSeq = 0;
    let terminalRow: OutboxRecord | undefined;
    try {
      for (;;) {
        const rows = await this.tasks.o.store.transaction((tx) =>
          tx.find<OutboxRecord>('outbox', {
            where: { aggregateId: taskId },
            orderBy: 'seq',
            afterSeq,
          }),
        );
        if (rows.length) afterSeq = rows[rows.length - 1]!.seq;
        terminalRow ??= rows.find(
          (r) =>
            r.value.sequence === 0 && isTerminal(TASK_MACHINE, r.value.status),
        )?.value;
        const fresh = rows
          .map((r) => r.value)
          .sort((a, b) => a.revision - b.revision || a.sequence - b.sequence)
          .filter((r) => isAfter(r, last));
        for (const r of fresh) {
          const { tenantId: _t, correlationId: _c, ...event } = toTaskEvent(r);
          void _t;
          void _c;
          last = { revision: r.revision, sequence: r.sequence };
          yield event;
        }
        // Events committed with the terminal transition (same transaction) were in this read; nothing follows.
        if (terminalRow && !isAfter(terminalRow, last)) return;
        // Events of a long-finished task may have been compacted away: stop instead of waiting forever.
        if (!terminalRow) {
          const t = await this.tasks.o.store.transaction((tx) =>
            tx.get<{ status: string }>('tasks', taskId),
          );
          if (t && isTerminal(TASK_MACHINE, t.value.status as never)) return;
        }
        if (abort?.aborted) return;
        await Promise.race([signal.promise, aborted]);
        if (abort?.aborted) return;
        signal = this.signal(taskId);
      }
    } finally {
      this.listeners.get(taskId)?.delete(signal.wake);
    }
  }

  private signal(taskId: string) {
    let wake!: () => void;
    const promise = new Promise<void>((r) => (wake = r));
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(wake);
    this.listeners.set(taskId, set);
    const entry = {
      promise: promise.then(() => {
        set.delete(wake);
      }),
      wake,
    };
    return entry;
  }
}
