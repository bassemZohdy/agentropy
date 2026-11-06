/**
 * Wake-up evaluation index (FEAT-033.2, R-06). Each armed registration carries `checkAt`: the time from which the
 * scheduler evaluates it. Timers and schedules set it to their due time; event, human-action and child-task
 * conditions set it to "now" through `pokeWakeups` when what they wait for happens, in the same transaction.
 * The poll reads only registrations with `checkAt <= now`, plus a periodic full scan as a backstop.
 */
import type { StoreTx } from '@agentropy/core';

/** Marks a task's armed wake-ups for evaluation by the next poll. */
export async function pokeWakeups(
  tx: StoreTx,
  taskId: string,
  now: string,
): Promise<void> {
  for (const w of await tx.find<{ checkAt?: string | null }>('wakeups', {
    where: { taskId, status: 'armed' },
  }))
    if (w.value.checkAt == null || w.value.checkAt > now)
      await tx.update('wakeups', w.id, w.revision, {
        ...w.value,
        checkAt: now,
      });
}
