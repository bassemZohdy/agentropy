/**
 * Compaction (M2-01, R-37; every collection since FEAT-040.1): removes the standing state of work that is over, so a
 * long-running deployment's store stops growing with its history.
 *
 * - Consumed mailbox rows and inbound-event dedupe records older than the window (duplicates are only detected
 *   inside it).
 * - For every task that ended before the window and has not been compacted: its published outbox rows, wake-ups,
 *   subscriptions and mailbox, effects journal, checkpoint, usage, human actions, executions, push configs and
 *   idempotency record. The task row itself stays (it is what `getTask` answers from) and is marked
 *   `compactedAt`, so later runs skip it.
 * - Terminal remote task projections last observed before the window, and inbox entries resolved or acknowledged
 *   before it.
 *
 * Work is done in short transactions (a batch of tasks each), never one transaction for the whole store.
 */
import {
  AgentropyError,
  type CollectionName,
  type FindOptions,
  type StoreTx,
  type StoredDocument,
} from '@agentropy/core';
import type { StoredHumanAction } from './human-actions.js';
import type { StoredInboxEntry } from './inbox.js';
import type { RemoteTaskRecord } from './remote.js';
import type { TaskRecord, TaskService } from './task-service.js';

export interface CompactionResult {
  mailbox: number;
  inboundEvents: number;
  outbox: number;
  wakeups: number;
  subscriptions: number;
  effects: number;
  checkpoints: number;
  usage: number;
  humanActions: number;
  executions: number;
  pushConfigs: number;
  /** A2A message history rows (FEAT-044.2). */
  a2aHistory: number;
  /** Expired memory entries (FEAT-045). */
  memories: number;
  idempotency: number;
  remoteTasks: number;
  inbox: number;
  /** Tasks whose standing state was removed in this run. */
  tasks: number;
}

/** Rows handled per transaction. */
const BATCH = 100;

type Counts = Partial<Record<keyof CompactionResult, number>>;

const add = (out: CompactionResult, c: Counts) => {
  for (const [k, n] of Object.entries(c) as [keyof CompactionResult, number][])
    out[k] += n;
};

export async function compactStore(
  tasks: TaskService,
  retainMs: number,
): Promise<CompactionResult> {
  if (
    typeof retainMs !== 'number' ||
    !Number.isFinite(retainMs) ||
    retainMs < 0
  )
    throw new AgentropyError(
      'SchemaViolation',
      'retainMs must be a non-negative number of milliseconds',
    );
  const store = tasks.o.store;
  const cutoff = new Date(Date.parse(tasks.o.now()) - retainMs).toISOString();
  const nowIso = tasks.o.now();
  const out: CompactionResult = {
    mailbox: 0,
    inboundEvents: 0,
    outbox: 0,
    wakeups: 0,
    subscriptions: 0,
    effects: 0,
    checkpoints: 0,
    usage: 0,
    humanActions: 0,
    executions: 0,
    pushConfigs: 0,
    a2aHistory: 0,
    memories: 0,
    idempotency: 0,
    remoteTasks: 0,
    inbox: 0,
    tasks: 0,
  };

  /**
   * Walks one indexed read in pages of `BATCH`, each page handled in its own transaction. A transaction callback may
   * run again after a serialization conflict, so it counts into a fresh object and the counts are added here, once
   * the transaction has committed (TASK-066).
   */
  const sweep = async <T>(
    collection: CollectionName,
    options: FindOptions<CollectionName>,
    handle: (tx: StoreTx, rows: StoredDocument<T>[]) => Promise<Counts>,
  ): Promise<void> => {
    let afterSeq = 0;
    for (;;) {
      const { counts, last, size } = await store.transaction(async (tx) => {
        const rows = await tx.find<T>(collection, {
          ...options,
          orderBy: 'seq',
          afterSeq,
          limit: BATCH,
        });
        return {
          counts: await handle(tx, rows),
          last: rows.at(-1)?.seq,
          size: rows.length,
        };
      });
      add(out, counts);
      if (size < BATCH || last === undefined) return;
      afterSeq = last;
    }
  };

  // Consumed mailbox rows, in batches (removing them moves the next page up, so no cursor).
  for (;;) {
    const n = await store.transaction(async (tx) => {
      const rows = await tx.find<{ consumed: number }>('mailbox', {
        where: { consumed: 1 },
        limit: BATCH * 5,
      });
      for (const m of rows) await tx.remove('mailbox', m.id, m.revision);
      return rows.length;
    });
    out.mailbox += n;
    if (n < BATCH * 5) break;
  }

  // Dedupe records that fell out of the window: only those, by the `at` index.
  await sweep<{ at: string }>(
    'inboundEvents',
    { range: { field: 'at', lte: cutoff } },
    async (tx, rows) => {
      let n = 0;
      for (const e of rows)
        if (e.value.at < cutoff) {
          await tx.remove('inboundEvents', e.id, e.revision);
          n++;
        }
      return { inboundEvents: n };
    },
  );

  // Tasks that ended before the window and are not compacted yet (the `compactedAt` index skips the others). The
  // ones still inside the window are read again by the next run, which is what retention means.
  for (const status of ['completed', 'failed', 'cancelled'])
    await sweep<TaskRecord & { compactedAt?: string }>(
      'tasks',
      { where: { status, compactedAt: null } },
      async (tx, rows) => {
        const c: Counts = {};
        const bump = (k: keyof CompactionResult, n = 1) =>
          (c[k] = (c[k] ?? 0) + n);
        for (const row of rows) {
          if (row.value.updatedAt >= cutoff) continue;
          for (const [k, n] of Object.entries(
            await compactTask(tx, row.id),
          ) as [keyof CompactionResult, number][])
            bump(k, n);
          await tx.update('tasks', row.id, row.revision, {
            ...row.value,
            compactedAt: nowIso,
          });
          bump('tasks');
        }
        return c;
      },
    );

  for (const status of ['completed', 'failed', 'cancelled'])
    await sweep<RemoteTaskRecord>(
      'remoteTasks',
      { where: { status }, range: { field: 'observedAt', lte: cutoff } },
      async (tx, rows) => {
        let n = 0;
        for (const r of rows)
          if (r.value.observedAt < cutoff) {
            await tx.remove('remoteTasks', r.id, r.revision);
            n++;
          }
        return { remoteTasks: n };
      },
    );

  // Inbox entries resolved, or acknowledged, before the window: the resolved ones by status, the open ones that are
  // neither new nor changed since they were shown (`pending: 0`) for an acknowledgement.
  for (const where of [
    { status: 'resolved' },
    { status: 'open', pending: 0 },
  ] as const)
    await sweep<StoredInboxEntry>('inbox', { where }, async (tx, rows) => {
      let n = 0;
      for (const e of rows) {
        const done =
          e.value.markers.resolvedAt ?? e.value.markers.acknowledgedAt;
        if (done !== undefined && done < cutoff) {
          await tx.remove('inbox', e.id, e.revision);
          n++;
        }
      }
      return { inbox: n };
    });

  // Memory entries past their expiry (FEAT-045), whatever the retention window: expiry is the entry's own.
  await sweep<{ expiresAt?: string }>(
    'memories',
    { range: { field: 'expiresAt', lte: nowIso } },
    async (tx, rows) => {
      let n = 0;
      for (const m of rows)
        if (m.value.expiresAt !== undefined && m.value.expiresAt <= nowIso) {
          await tx.remove('memories', m.id, m.revision);
          n++;
        }
      return { memories: n };
    },
  );
  return out;
}

/** Removes everything that belongs to one ended task and returns what it removed. */
async function compactTask(tx: StoreTx, taskId: string): Promise<Counts> {
  const c: Counts = {};
  const bump = (k: keyof CompactionResult) => (c[k] = (c[k] ?? 0) + 1);
  const drop = async (
    collection:
      | 'wakeups'
      | 'subscriptions'
      | 'mailbox'
      | 'effects'
      | 'usage'
      | 'humanActions'
      | 'executions'
      | 'pushConfigs'
      | 'a2aHistory'
      | 'idempotency',
    count: keyof CompactionResult,
  ) => {
    for (const d of await tx.find<StoredHumanAction>(collection, {
      where: { taskId },
    })) {
      await tx.remove(collection, d.id, d.revision);
      bump(count);
    }
  };
  for (const r of await tx.find<{ published: number }>('outbox', {
    where: { aggregateId: taskId },
  }))
    if (r.value.published === 1) {
      await tx.remove('outbox', r.id, r.revision);
      bump('outbox');
    }
  await drop('wakeups', 'wakeups');
  await drop('subscriptions', 'subscriptions');
  await drop('mailbox', 'mailbox');
  await drop('effects', 'effects');
  await drop('usage', 'usage');
  await drop('humanActions', 'humanActions');
  await drop('executions', 'executions');
  await drop('pushConfigs', 'pushConfigs');
  await drop('a2aHistory', 'a2aHistory');
  await drop('idempotency', 'idempotency');
  const cp = await tx.get('checkpoints', taskId);
  if (cp) {
    await tx.remove('checkpoints', taskId, cp.revision);
    bump('checkpoints');
  }
  return c;
}
