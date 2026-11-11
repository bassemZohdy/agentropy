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
import type { StoreTx } from '@agentropy/core';
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
  idempotency: number;
  remoteTasks: number;
  inbox: number;
  /** Tasks whose standing state was removed in this run. */
  tasks: number;
}

/** Tasks handled per transaction. */
const BATCH = 100;

export async function compactStore(
  tasks: TaskService,
  retainMs: number,
): Promise<CompactionResult> {
  const store = tasks.o.store;
  const cutoff = new Date(Date.parse(tasks.o.now()) - retainMs).toISOString();
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
    idempotency: 0,
    remoteTasks: 0,
    inbox: 0,
    tasks: 0,
  };

  // Consumed mailbox rows, in batches.
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

  await store.transaction(async (tx) => {
    for (const e of await tx.find<{ at: string }>('inboundEvents', {}))
      if (e.value.at < cutoff) {
        await tx.remove('inboundEvents', e.id, e.revision);
        out.inboundEvents++;
      }
  });

  // Tasks that ended before the window and are not compacted yet.
  const ended: string[] = [];
  await store.transaction(async (tx) => {
    for (const status of ['completed', 'failed', 'cancelled'])
      for (const t of await tx.find<TaskRecord & { compactedAt?: string }>(
        'tasks',
        { where: { status } },
      ))
        if (t.value.updatedAt < cutoff && !t.value.compactedAt)
          ended.push(t.id);
  });
  for (let i = 0; i < ended.length; i += BATCH) {
    await store.transaction(async (tx) => {
      for (const id of ended.slice(i, i + BATCH)) {
        await compactTask(tx, id, out);
        const t = await tx.get<TaskRecord & { compactedAt?: string }>(
          'tasks',
          id,
        );
        if (t)
          await tx.update('tasks', id, t.revision, {
            ...t.value,
            compactedAt: tasks.o.now(),
          });
        out.tasks++;
      }
    });
  }

  await store.transaction(async (tx) => {
    for (const status of ['completed', 'failed', 'cancelled'])
      for (const r of await tx.find<RemoteTaskRecord>('remoteTasks', {
        where: { status },
      }))
        if (r.value.observedAt < cutoff) {
          await tx.remove('remoteTasks', r.id, r.revision);
          out.remoteTasks++;
        }
    for (const e of await tx.find<StoredInboxEntry>('inbox', {})) {
      const done = e.value.markers.resolvedAt ?? e.value.markers.acknowledgedAt;
      if (done !== undefined && done < cutoff) {
        await tx.remove('inbox', e.id, e.revision);
        out.inbox++;
      }
    }
  });
  return out;
}

/** Removes everything that belongs to one ended task, counting what it removed. */
async function compactTask(
  tx: StoreTx,
  taskId: string,
  out: CompactionResult,
): Promise<void> {
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
      out[count]++;
    }
  };
  for (const r of await tx.find<{ published: number }>('outbox', {
    where: { aggregateId: taskId },
  }))
    if (r.value.published === 1) {
      await tx.remove('outbox', r.id, r.revision);
      out.outbox++;
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
    out.checkpoints++;
  }
}
