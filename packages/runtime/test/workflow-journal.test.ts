// workflow.start is journaled by its step key: engines that ignore the idempotency key (Conductor OSS) still see one
// start per key, because a replayed step returns the recorded run.
import type { WorkflowEngine, WorkflowRun } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { workflowOperationHandlers } from '../src/workflow.js';
import { harness, completes } from './harness.js';

describe('workflow.start journal', () => {
  it('a replayed step key returns the first run without asking the engine again, with or without engine support', async () => {
    const h = harness();
    h.define('d', completes());
    const t = await h.delegate((await h.instance('d')).id, {}, 'k');
    let starts = 0;
    const engine: WorkflowEngine = {
      id: 'forgetful', // ignores the idempotency key, like Conductor OSS
      start: async () => ({ runId: `run-${++starts}`, state: 'running' }),
      status: async (runId): Promise<WorkflowRun> => ({
        runId,
        state: 'running',
      }),
      onFinished: () => undefined,
    };
    const ctx = (key: string) => ({
      tenantId: 't-1',
      taskId: t.taskId,
      executionId: 'x',
      principalId: 'agent',
      idempotencyKey: key,
      stepKey: 'go',
      signal: new AbortController().signal,
    });
    const { start } = workflowOperationHandlers(engine, {
      store: h.store,
      now: h.clock.iso,
    });
    const first = await start!({ workflow: 'w', input: {} }, ctx('key-1'));
    const replay = await start!({ workflow: 'w', input: {} }, ctx('key-1'));
    const other = await start!({ workflow: 'w', input: {} }, ctx('key-2'));
    expect(replay).toEqual(first);
    expect(other).not.toEqual(first);
    expect(starts).toBe(2);

    // Without the journal the engine is asked every time.
    const bare = workflowOperationHandlers(engine);
    await bare.start!({ workflow: 'w', input: {} }, ctx('key-3'));
    await bare.start!({ workflow: 'w', input: {} }, ctx('key-3'));
    expect(starts).toBe(4);
  });
});
