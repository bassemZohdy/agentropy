// FEAT-041.3: reasoning.complete reserves its tokens before the call, so concurrent calls of one activation cannot
// overspend the task budget together, and a failed call gives its reservation back.
import type { ReasoningProvider } from '@agentropy/core';
import { describe, expect, it, vi } from 'vitest';
import { reasoningOperationHandlers } from '../src/reasoning.js';
import { alice, code, completes, harness } from './harness.js';

describe('reasoning budget reservation (FEAT-041.3)', () => {
  it('a concurrent call is refused while the budget is reserved; a failed call releases its reservation; later calls get what remains', async () => {
    const h = harness();
    h.define('r', completes());
    const inst = await h.instance('r');
    const t = await h.delegate(inst.id, {}, 'k', alice, {
      budget: { maxCostUnits: 100 },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let fail = false;
    const asked: number[] = [];
    const provider: ReasoningProvider = {
      id: 'stub',
      complete: async (req) => {
        asked.push(req.maxTokens);
        await gate;
        if (fail) throw new Error('model down');
        return {
          text: 'x',
          usage: { inputTokens: 10, outputTokens: 50 },
          model: 'm',
        };
      },
    };
    const { complete } = reasoningOperationHandlers({
      tasks: h.tasks,
      provider,
    });
    const ctx = {
      tenantId: 't-1',
      taskId: t.taskId,
      executionId: 'ex-1',
      principalId: 'agent',
      signal: new AbortController().signal,
    };

    const first = complete!({ prompt: 'a' }, ctx); // reserves the whole budget
    await vi.waitFor(() => expect(asked).toEqual([100]));
    expect(await code(complete!({ prompt: 'b' }, ctx))).toBe('BudgetExceeded');
    expect(asked).toHaveLength(1); // the refused call never reached the model
    release();
    await first; // spent 60 of 100

    fail = true;
    expect(await code(complete!({ prompt: 'c' }, ctx))).toMatch(
      /ProviderUnavailable|Internal|non-agentropy/,
    );
    fail = false;
    await complete!({ prompt: 'd' }, ctx); // not blocked by the failed call's reservation
    expect(asked).toEqual([100, 40, 40]);
  });

  it('a reservation left by another execution does not block this one', async () => {
    const h = harness();
    h.define('r', completes());
    const inst = await h.instance('r');
    const t = await h.delegate(inst.id, {}, 'k', alice, {
      budget: { maxCostUnits: 100 },
    });
    const asked: number[] = [];
    const never = new Promise<never>(() => undefined);
    const stuck: ReasoningProvider = {
      id: 'stuck',
      complete: (req) => (asked.push(req.maxTokens), never),
    };
    const ok: ReasoningProvider = {
      id: 'ok',
      complete: async (req) => {
        asked.push(req.maxTokens);
        return {
          text: 'x',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'm',
        };
      },
    };
    const base = {
      tenantId: 't-1',
      taskId: t.taskId,
      principalId: 'agent',
      signal: new AbortController().signal,
    };
    // Execution 1 reserves everything and "crashes" (never returns).
    void reasoningOperationHandlers({ tasks: h.tasks, provider: stuck })
      .complete!({ prompt: 'a' }, { ...base, executionId: 'ex-1' });
    await vi.waitFor(() => expect(asked).toEqual([100]));
    // Its successor starts with a clean slate.
    await reasoningOperationHandlers({ tasks: h.tasks, provider: ok })
      .complete!({ prompt: 'b' }, { ...base, executionId: 'ex-2' });
    expect(asked).toEqual([100, 100]);
  });
});
