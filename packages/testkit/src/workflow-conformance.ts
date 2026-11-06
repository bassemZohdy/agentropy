/**
 * Reusable WorkflowEngine conformance suite (FEAT-028.6, C-05, X-10). Any engine adapter must pass it offline:
 * idempotent start per key, tenant-scoped status without disclosure, terminal-state mapping, and exactly one
 * completion report per terminal run with the owning tenant. The harness drives runs to an end through
 * `finish`, because only the engine (or its fake) knows how a run completes.
 */
import type { WorkflowEngine, WorkflowRun } from '@agentropy/core';
import type { TestApi } from './communication.js';

export interface WorkflowConformanceHarness {
  engine: WorkflowEngine;
  /** Drive a running run to an end, then let the adapter report it (webhook, poll, …). */
  finish(
    runId: string,
    outcome: { output: unknown } | { failed: true },
  ): Promise<void>;
  /** Name of a workflow the engine knows. */
  workflow: string;
}

export function defineWorkflowEngineConformance(
  t: TestApi,
  name: string,
  setup: () => Promise<WorkflowConformanceHarness> | WorkflowConformanceHarness,
): void {
  const ctx = (tenantId: string, key: string) => ({
    tenantId,
    taskId: `task-${key}`,
    idempotencyKey: key,
  });

  t.describe(`workflow engine conformance: ${name}`, () => {
    t.it('start is idempotent per key and returns a running run', async () => {
      const h = await setup();
      const a = await h.engine.start(h.workflow, { n: 1 }, ctx('t-1', 'k1'));
      const again = await h.engine.start(
        h.workflow,
        { n: 1 },
        ctx('t-1', 'k1'),
      );
      const other = await h.engine.start(
        h.workflow,
        { n: 2 },
        ctx('t-1', 'k2'),
      );
      t.expect(a.state).toBe('running');
      t.expect(again.runId).toBe(a.runId);
      t.expect(other.runId === a.runId).toBe(false);
    });

    t.it(
      'status is tenant-scoped: another tenant or an unknown run is NotFound',
      async () => {
        const h = await setup();
        const run = await h.engine.start(h.workflow, {}, ctx('t-1', 'k'));
        t.expect(
          (await h.engine.status(run.runId, { tenantId: 't-1' })).state,
        ).toBe('running');
        t.expect(await h.engine.status(run.runId, { tenantId: 't-2' })).toEqual(
          {
            runId: run.runId,
            state: 'failed',
            code: 'NotFound',
          },
        );
        t.expect(
          (await h.engine.status('no-such-run', { tenantId: 't-1' })).code,
        ).toBe('NotFound');
      },
    );

    t.it(
      'completion carries the output; failure carries an error code',
      async () => {
        const h = await setup();
        const ok = await h.engine.start(h.workflow, {}, ctx('t-1', 'ok'));
        const bad = await h.engine.start(h.workflow, {}, ctx('t-1', 'bad'));
        await h.finish(ok.runId, { output: { total: 42 } });
        await h.finish(bad.runId, { failed: true });
        const done = await h.engine.status(ok.runId, { tenantId: 't-1' });
        t.expect([done.state, done.output]).toEqual([
          'completed',
          { total: 42 },
        ]);
        const failed = await h.engine.status(bad.runId, { tenantId: 't-1' });
        t.expect(failed.state).toBe('failed');
        t.expect(
          typeof failed.code === 'string' && failed.code !== 'NotFound',
        ).toBe(true);
      },
    );

    t.it('reports each terminal run once, with its tenant', async () => {
      const h = await setup();
      const seen: (WorkflowRun & { tenantId: string })[] = [];
      h.engine.onFinished((r) => seen.push(r));
      const run = await h.engine.start(h.workflow, {}, ctx('t-9', 'once'));
      await h.finish(run.runId, { output: 'x' });
      await h.finish(run.runId, { output: 'x' });
      t.expect(seen.map((r) => [r.runId, r.state, r.tenantId])).toEqual([
        [run.runId, 'completed', 't-9'],
      ]);
    });
  });
}
