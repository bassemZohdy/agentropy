/**
 * A2A message history (FEAT-044.2). With `history: { store }` the endpoint keeps the user messages it accepted for a
 * task so that `historyLength` (on `GetTask`, `ListTasks` and the `SendMessage` configuration) has something to
 * return. Nothing is kept without it, and `historyLength` then has no effect.
 *
 * - **Per sender.** A message is recorded for the principal that sent it and read back only for that principal, as
 *   push configs are: a task's owner who sent nothing sees no history, and one caller never reads another's messages.
 * - **Bounded.** At most `maxMessages` (default 100) per principal and task, the newest kept; a message is stored
 *   once per message ID, so a replay adds nothing.
 * - **Minimal.** Role, message ID, context ID, task ID and parts; `metadata` (which may carry an Agentropy envelope)
 *   is never stored. Parts were validated when the message was accepted.
 * - **Retained with the task.** `compact()` removes the rows of an ended task.
 */
import {
  AgentropyError,
  type Store,
  type TrustedPrincipal,
} from '@agentropy/core';
import type { A2AMessage } from './a2a-protocol.js';

export interface A2AHistoryOptions {
  store: Store;
  /** Messages kept per principal and task (default 100); the newest win. */
  maxMessages?: number;
}

export interface A2AHistory {
  /** Records an accepted message for the caller; the same message ID is stored once. */
  record(
    caller: TrustedPrincipal,
    taskId: string,
    message: A2AMessage,
  ): Promise<void>;
  /** The caller's messages for the task, oldest first; `limit` keeps the most recent ones (0 keeps none). */
  read(
    caller: TrustedPrincipal,
    taskId: string,
    limit: number | undefined,
  ): Promise<A2AMessage[]>;
}

interface HistoryRow {
  tenantId: string;
  taskId: string;
  principalId: string;
  seq: number;
  message: A2AMessage;
}

const DEFAULT_MAX_MESSAGES = 100;

export function createA2AHistory(o: A2AHistoryOptions): A2AHistory {
  const max = o.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (!Number.isInteger(max) || max < 1)
    throw new AgentropyError(
      'InvalidConfiguration',
      'history.maxMessages must be a positive integer',
    );
  return {
    record: (caller, taskId, message) =>
      o.store.transaction(async (tx) => {
        const key = JSON.stringify([
          caller.tenantId,
          caller.id,
          taskId,
          message.messageId,
        ]);
        if (await tx.get('a2aHistory', key)) return;
        const mine = (
          await tx.find<HistoryRow>('a2aHistory', {
            where: { tenantId: caller.tenantId, taskId },
          })
        ).filter((d) => d.value.principalId === caller.id);
        const seq = mine.reduce((m, d) => Math.max(m, d.value.seq), 0) + 1;
        await tx.insert<HistoryRow>('a2aHistory', key, {
          tenantId: caller.tenantId,
          taskId,
          principalId: caller.id,
          seq,
          message: {
            role: 'ROLE_USER',
            messageId: message.messageId,
            ...(message.contextId ? { contextId: message.contextId } : {}),
            taskId,
            parts: message.parts,
          },
        });
        const excess = mine.length + 1 - max;
        if (excess > 0)
          for (const d of mine
            .sort((a, b) => a.value.seq - b.value.seq)
            .slice(0, excess))
            await tx.remove('a2aHistory', d.id, d.revision);
      }),
    read: async (caller, taskId, limit) => {
      if (limit === 0) return [];
      const rows = await o.store.transaction((tx) =>
        tx.find<HistoryRow>('a2aHistory', {
          where: { tenantId: caller.tenantId, taskId },
        }),
      );
      const all = rows
        .filter((d) => d.value.principalId === caller.id)
        .sort((a, b) => a.value.seq - b.value.seq)
        .map((d) => d.value.message);
      return limit === undefined ? all : all.slice(-limit);
    },
  };
}
