/**
 * Offline WorkflowEngine for tests and examples: runs registered async functions as "workflows", idempotent per
 * key, completing when `finish` is called (or immediately with `autoFinish`). Not a workflow engine — real engines
 * (Temporal, Quarkus Flow, …) plug in through the same SPI.
 */
import type { WorkflowEngine, WorkflowRun } from '@agentropy/core';

export class FakeWorkflowEngine implements WorkflowEngine {
  readonly id = 'fake-workflow';
  readonly runs = new Map<
    string,
    WorkflowRun & { tenantId: string; workflow: string; input: unknown }
  >();
  private readonly byKey = new Map<string, string>();
  private readonly listeners: ((
    run: WorkflowRun & { tenantId: string },
  ) => void)[] = [];
  starts = 0;

  constructor(
    private readonly workflows: Record<
      string,
      (input: unknown) => unknown | Promise<unknown>
    > = {},
  ) {}

  async start(
    workflow: string,
    input: unknown,
    ctx: { tenantId: string; taskId: string; idempotencyKey: string },
  ): Promise<WorkflowRun> {
    const existing = this.byKey.get(ctx.idempotencyKey);
    if (existing) return this.view(existing);
    this.starts++;
    const runId = `run-${this.runs.size + 1}`;
    this.byKey.set(ctx.idempotencyKey, runId);
    this.runs.set(runId, {
      runId,
      state: 'running',
      tenantId: ctx.tenantId,
      workflow,
      input,
    });
    return this.view(runId);
  }

  async status(runId: string, ctx: { tenantId: string }): Promise<WorkflowRun> {
    const r = this.runs.get(runId);
    if (!r || r.tenantId !== ctx.tenantId)
      return { runId, state: 'failed', code: 'NotFound' };
    return this.view(runId);
  }

  onFinished(
    listener: (run: WorkflowRun & { tenantId: string }) => void,
  ): void {
    this.listeners.push(listener);
  }

  /** Execute a running workflow's function and report completion (or failure). */
  async finish(runId: string): Promise<void> {
    const r = this.runs.get(runId);
    if (!r || r.state !== 'running') return;
    const fn = this.workflows[r.workflow];
    try {
      if (!fn) throw new Error(`unknown workflow ${r.workflow}`);
      r.output = await fn(r.input);
      r.state = 'completed';
    } catch {
      r.state = 'failed';
      r.code = 'TaskFailed';
    }
    for (const l of this.listeners)
      l({ ...this.view(runId), tenantId: r.tenantId });
  }

  private view(runId: string): WorkflowRun {
    const r = this.runs.get(runId)!;
    return {
      runId,
      state: r.state,
      ...(r.output !== undefined ? { output: r.output } : {}),
      ...(r.code ? { code: r.code } : {}),
    };
  }
}
