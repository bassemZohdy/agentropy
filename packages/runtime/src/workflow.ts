/**
 * `workflow.start` / `workflow.status` backed by a WorkflowEngine (ADR-0006, M2-07). The engine owns
 * deterministic execution; Agentropy only starts runs idempotently (the derived step key is the engine's
 * idempotency key) and turns engine completion into an inbound `workflow` event, so the waiting agent task wakes
 * through its ordinary event subscription (filter `{ runId }`). Subscribe before starting so no completion is
 * missed. No workflow semantics (steps, branching, compensation) live in Agentropy.
 */
import {
  AgentropyError,
  type CapabilityInvocationContext,
  type WorkflowEngine,
} from '@agentropy/core';

/** Source of the completion events; subscribe with `{ source: WORKFLOW_SOURCE, filter: { runId } }`. */
export const WORKFLOW_SOURCE = 'workflow';

export function workflowOperationHandlers(
  engine: WorkflowEngine,
): Record<
  string,
  (input: unknown, ctx: CapabilityInvocationContext) => Promise<unknown>
> {
  return {
    start: async (raw, ctx) => {
      const input = raw as { workflow?: string; input?: unknown };
      if (!input?.workflow || typeof input.workflow !== 'string')
        throw new AgentropyError(
          'SchemaViolation',
          'workflow.start needs a workflow name',
        );
      if (!ctx.idempotencyKey)
        throw new AgentropyError(
          'SchemaViolation',
          'workflow.start requires a stepKey',
          {
            details: { reason: 'missingStepKey' },
          },
        );
      return engine.start(input.workflow, input.input, {
        tenantId: ctx.tenantId,
        taskId: ctx.taskId,
        idempotencyKey: ctx.idempotencyKey,
      });
    },
    status: async (raw, ctx) => {
      const { runId } = (raw ?? {}) as { runId?: string };
      if (!runId)
        throw new AgentropyError(
          'SchemaViolation',
          'workflow.status needs a runId',
        );
      return engine.status(runId, { tenantId: ctx.tenantId });
    },
  };
}

/** Bridges engine completions into the trusted event ingress (deduplicated by run ID). */
export function bridgeWorkflowCompletions(
  engine: WorkflowEngine,
  publish: (event: {
    eventId: string;
    source: string;
    tenantId: string;
    payload: unknown;
  }) => Promise<boolean>,
): void {
  engine.onFinished((run) => {
    void publish({
      eventId: `workflow:${run.runId}:${run.state}`,
      source: WORKFLOW_SOURCE,
      tenantId: run.tenantId,
      payload: {
        runId: run.runId,
        state: run.state,
        ...(run.output !== undefined ? { output: run.output } : {}),
        ...(run.code ? { code: run.code } : {}),
      },
    });
  });
}
