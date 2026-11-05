// A-02 / CT-IMPLEMENTATION parity: native-ts and pure-fn implementations pass the same lifecycle scenarios
// through the TaskService and runtime, without bypassing them.
import type {
  AgentDefinition,
  AgentDisposition,
  WakeReason,
} from '@agentropy/core';
import { describe, expect, it } from 'vitest';
import { PureFunctionImplementationProvider } from '../src/implementation.js';
import { alice, code, harness } from './harness.js';

type Logic = (s: {
  input: unknown;
  attempt: number;
  checkpoint?: unknown;
  wakeReason?: WakeReason;
}) => AgentDisposition<unknown>;

const scenarios: Record<
  string,
  { logic: Logic; over?: Partial<AgentDefinition> }
> = {
  completes: {
    logic: ({ input }) => ({
      kind: 'completed',
      output: { doubled: (input as { n: number }).n * 2 },
    }),
  },
  'retries then completes': {
    logic: ({ attempt }) =>
      attempt < 2
        ? {
            kind: 'failed',
            code: 'ProviderUnavailable',
            retryable: true,
            message: 'transient',
          }
        : { kind: 'completed', output: attempt },
  },
  'fails permanently': {
    logic: () => ({
      kind: 'failed',
      code: 'BudgetExceeded',
      retryable: false,
      message: 'no budget',
    }),
  },
  'yields with a checkpoint': {
    logic: () => ({
      kind: 'waiting',
      wakeup: { anyOf: [{ kind: 'timer', at: '2026-11-07T00:00:00.000Z' }] },
      checkpoint: { step: 1 },
    }),
  },
  'invalid output': {
    logic: () => ({ kind: 'completed', output: 'not-an-object' }),
    over: { outputSchema: { type: 'object' } },
  },
};

async function run(provider: 'native-ts' | 'pure-fn', name: string) {
  const pure = new PureFunctionImplementationProvider();
  const h = harness({ extraProviders: [pure] });
  const { logic, over } = scenarios[name]!;
  const artifact = { id: 'agent', version: '1.0.0' };
  if (provider === 'pure-fn') pure.register(artifact, (s) => logic(s));
  h.define(
    'agent',
    { handle: async (inv) => logic(inv) },
    {
      ...over,
      implementation: {
        providerId: provider,
        providerVersion: '1.0.0',
        artifact,
      },
    },
  );
  const t = await h.delegate(h.instance('agent').id, { n: 21 }, 'k');
  for (let i = 0; i < 3; i++) {
    await h.runtime.runUntilIdle();
    h.clock.advance(5_000);
  }
  const snap = await h.tasks.getTask(t.taskId, alice);
  const execs = (
    await h.store.transaction((tx) =>
      tx.find<{ state: string; attempt: number }>('executions', {
        where: { taskId: t.taskId },
      }),
    )
  ).map((e) => [e.value.state, e.value.attempt]);
  const cp = await h.store.transaction((tx) => tx.get('checkpoints', t.taskId));
  const result =
    snap.status === 'completed'
      ? await h.tasks.getResult(t.taskId, alice)
      : await code(h.tasks.getResult(t.taskId, alice));
  return {
    status: snap.status,
    revision: snap.revision,
    outcome: snap.outcome,
    execs,
    checkpoint: cp?.value,
    result,
  };
}

describe('implementation parity (A-02)', () => {
  it.each(Object.keys(scenarios))(
    '%s: identical lifecycle through native-ts and pure-fn',
    async (name) => {
      const native = await run('native-ts', name);
      const pure = await run('pure-fn', name);
      expect(pure).toEqual(native);
    },
  );

  it('the scenarios cover completed, failed, waiting and retry paths', async () => {
    const statuses = await Promise.all(
      Object.keys(scenarios).map(async (n) => (await run('pure-fn', n)).status),
    );
    expect(new Set(statuses)).toEqual(
      new Set(['completed', 'failed', 'waiting']),
    );
  });

  it('pure-fn declares no cooperative cancellation; acceptance still pins it for durable profiles', async () => {
    const pure = new PureFunctionImplementationProvider();
    expect(pure.features).toMatchObject({
      checkpointResume: true,
      cooperativeCancellation: false,
    });
    pure.register({ id: 'a', version: '1.0.0' }, () => ({
      kind: 'completed',
      output: null,
    }));
    expect(
      await code(
        pure.resolve({
          providerId: 'pure-fn',
          providerVersion: '1.0.0',
          artifact: { id: 'missing', version: '1.0.0' },
        }),
      ),
    ).toBe('NotFound');
  });
});
