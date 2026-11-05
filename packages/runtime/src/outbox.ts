/**
 * Outbox relay and TaskEvent streams (messaging contract "Publication and inbox reconciliation", R-29, AC-19).
 *
 * Transitions and their outbox rows commit together (TaskService). The relay leases nothing: it reads unpublished
 * rows in commit order, hands each to every consumer and only then marks it published. A crash anywhere before
 * the mark re-delivers the row after restart, so delivery is at-least-once and consumers deduplicate by event ID
 * (or by the `(revision, sequence)` pair). No external exactly-once is claimed.
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
  /** Leader lease length (default 30 s). */
  leaseMs?: number;
  /** Delivery lag and terminal-outcome metrics, recorded once per published row. */
  telemetry?: Telemetry;
  now?: () => string;
}

export class OutboxRelay {
  private readonly consumers: EventConsumer[];
  private draining?: Promise<number>;

  constructor(private readonly o: OutboxRelayOptions) {
    this.consumers = [...(o.consumers ?? [])];
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
    let published = 0;
    if (!(await this.lead())) return 0;
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
          await this.o.store.transaction(async (tx) => {
            const cur = await tx.get<OutboxRecord>('outbox', row.id);
            if (cur && cur.value.published === 0)
              await tx.update<OutboxRecord>('outbox', cur.id, cur.revision, {
                ...cur.value,
                attempts: cur.value.attempts + 1,
                lastError: err instanceof Error ? err.name : 'Error',
              });
          });
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

  /** Events of one visible task after `from`, ending after its terminal event. */
  async *subscribe(
    taskId: string,
    caller: TrustedPrincipal,
    from?: { revision: number; sequence: number },
  ): AsyncIterable<TaskEvent> {
    await this.tasks.visible(taskId, caller);
    let last = from;
    let signal = this.signal(taskId);
    try {
      for (;;) {
        const rows = await this.tasks.o.store.transaction((tx) =>
          tx.find<OutboxRecord>('outbox', {
            where: { aggregateId: taskId },
            orderBy: 'seq',
          }),
        );
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
        const terminal = rows.find(
          (r) =>
            r.value.sequence === 0 && isTerminal(TASK_MACHINE, r.value.status),
        );
        if (terminal && !isAfter(terminal.value, last)) return;
        // Events of a long-finished task may have been compacted away: stop instead of waiting forever.
        if (!terminal) {
          const t = await this.tasks.o.store.transaction((tx) =>
            tx.get<{ status: string }>('tasks', taskId),
          );
          if (t && isTerminal(TASK_MACHINE, t.value.status as never)) return;
        }
        await signal.promise;
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
