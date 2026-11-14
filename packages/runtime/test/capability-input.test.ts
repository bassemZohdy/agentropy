// FEAT-071: the built-in operations declare input schemas, and the runtime validates an invocation's input against
// them before the provider runs, so a malformed input is a SchemaViolation (not retried) instead of a TypeError
// inside the provider that becomes a retried Internal.
import { CAPABILITY_CATALOG, type Agent } from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { alice, harness } from './harness.js';

type H = ReturnType<typeof harness>;

/** An agent that makes one capability call with the given input and returns what happened. */
function caller(capability: string, operation: string, input: unknown): Agent {
  return {
    handle: async (_inv, ctx) => ({
      kind: 'completed',
      output: await ctx.capabilities.invoke(capability, operation, input, {
        stepKey: 's',
      }),
    }),
  };
}

async function run(
  h: H,
  id: string,
  capability: string,
  op: string,
  input: unknown,
) {
  h.define(id, caller(capability, op, input), {
    capabilities: [{ id: capability, versionRange: '^1.0.0' }],
  });
  const t = await h.delegate((await h.instance(id)).id, {}, id);
  await h.runtime.runUntilIdle();
  const snap = await h.tasks.getTask(t.taskId, alice);
  const executions = await h.store.transaction((tx) =>
    tx.find('executions', { where: { taskId: t.taskId } }),
  );
  return { snap, attempts: executions.length, calls: h.cap.calls };
}

describe('built-in operation inputs are validated before the provider runs (FEAT-071)', () => {
  it('FEAT-071: every operation that takes fields declares a schema for them', () => {
    const declared = (id: string, op: string) =>
      CAPABILITY_CATALOG.find((c) => c.id === id)?.operations.find(
        (o) => o.name === op,
      )?.inputSchema;
    for (const [id, op] of [
      ['delegation', 'delegate'],
      ['delegation', 'getTask'],
      ['delegation', 'cancel'],
      ['event-handling', 'subscribe'],
      ['event-handling', 'unsubscribe'],
      ['scheduling', 'nextOccurrence'],
      ['reasoning', 'complete'],
      ['tool-use', 'call'],
      ['workflow', 'start'],
      ['workflow', 'status'],
    ] as const)
      expect(declared(id, op), `${id}.${op}`).not.toBe(true);
  });

  it('FEAT-071: delegation.getTask with a null input fails SchemaViolation after one attempt and never reaches the provider', async () => {
    const h = harness();
    const r = await run(h, 'bad-get', 'delegation', 'getTask', null);
    expect(r.snap.status).toBe('failed');
    expect(r.snap.outcome?.code).toBe('SchemaViolation');
    expect(r.attempts).toBe(1);
    expect(r.calls).toEqual([]);
  });

  it('FEAT-071: reasoning.complete refuses a non-integer or non-positive maxTokens, and takes a valid one', async () => {
    for (const [i, maxTokens] of [1.5, 0, -3, '10'].entries()) {
      const h = harness();
      const r = await run(h, `bad-${i}`, 'reasoning', 'complete', {
        prompt: 'hi',
        maxTokens,
      });
      expect(r.snap.outcome?.code, String(maxTokens)).toBe('SchemaViolation');
      expect(r.attempts).toBe(1);
      expect(r.calls).toEqual([]);
    }
    const ok = harness();
    const r = await run(ok, 'good', 'reasoning', 'complete', {
      prompt: 'hi',
      maxTokens: 20,
    });
    expect(r.snap.status).toBe('completed');
    expect(r.calls).toHaveLength(1);
  });

  it('FEAT-071: other malformed inputs are refused the same way', async () => {
    for (const [i, [cap, op, input]] of (
      [
        ['delegation', 'cancel', { taskId: 7 }],
        ['event-handling', 'subscribe', {}],
        ['scheduling', 'nextOccurrence', { cron: '* * * * *' }],
        ['tool-use', 'call', 'x'],
        ['workflow', 'start', { workflow: '' }],
      ] as const
    ).entries()) {
      const h = harness();
      const r = await run(h, `m-${i}`, cap, op, input);
      expect(r.snap.outcome?.code, `${cap}.${op}`).toBe('SchemaViolation');
      expect(r.attempts).toBe(1);
    }
  });
});
