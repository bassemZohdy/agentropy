/**
 * Quickstart (docs/quickstart.md, FEAT-028.10): one durable agent that starts work, waits for a timer without
 * holding a worker, resumes from its checkpoint and completes. Run it with `pnpm example:quickstart`.
 * Every step here is what docs/quickstart.md walks through; CI runs this file.
 */
import { createLocalApp } from '@agentropy/runtime';
import type { Agent } from '@agentropy/core';
import {
  SameTenantPolicy,
  definition,
  isMain,
  tempStore,
  user,
} from './common.js';

// 1. An agent is a handler: it gets an invocation and returns a disposition.
const reminder: Agent<{ message: string; delayMs: number }> = {
  handle: async (inv) => {
    if (inv.activation === 1) {
      const at = new Date(Date.now() + inv.input.delayMs).toISOString();
      // Waiting releases the worker; the checkpoint is stored with the wake-up.
      return {
        kind: 'waiting',
        wakeup: { anyOf: [{ kind: 'timer', at }] },
        checkpoint: { scheduledFor: at },
      };
    }
    const { scheduledFor } = inv.checkpoint as { scheduledFor: string };
    return {
      kind: 'completed',
      output: { reminder: inv.input.message, scheduledFor },
    };
  },
};

export async function runQuickstart(): Promise<{
  status: string;
  output: unknown;
}> {
  // 2. A local app: a durable store and your policy decision point (the example allows same-tenant calls).
  const app = createLocalApp({
    store: tempStore('quickstart'),
    pdp: new SameTenantPolicy(),
  });
  // 3. Register the definition (versioned blueprint) with its handler.
  app.define(definition('reminder'), reminder);

  // 4. Create an owner-scoped instance, then delegate a task to it with an idempotency key.
  const alice = user('alice');
  const instance = await app.createInstance(
    {
      definition: { id: 'reminder', version: '1.0.0' },
      ownerId: alice.id,
      idempotencyKey: 'my-reminder',
    },
    alice,
  );
  const task = await app.delegate(
    {
      target: { instanceId: instance.id },
      input: { message: 'stand-up in 5 minutes', delayMs: 200 },
      idempotencyKey: 'reminder-1',
      correlationId: 'quickstart',
    },
    alice,
  );

  // 5. Run the scheduler loop (a long-running process would just call start()).
  const stop = app.start(50);
  for (let i = 0; i < 100; i++) {
    const t = await app.getTask(task.taskId, alice);
    if (t.status === 'completed' || t.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await stop();

  // 6. Read the result as the caller.
  const snapshot = await app.getTask(task.taskId, alice);
  const output =
    snapshot.status === 'completed'
      ? await app.getResult(task.taskId, alice)
      : undefined;
  await app.store.close();
  return { status: snapshot.status, output };
}

if (isMain(import.meta.url)) {
  const r = await runQuickstart();
  console.log(JSON.stringify(r, null, 2));
  if (r.status !== 'completed') process.exit(1);
}
