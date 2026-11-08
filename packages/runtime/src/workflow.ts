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
  type Store,
  type WorkflowEngine,
} from '@agentropy/core';

/** Source of the completion events; subscribe with `{ source: WORKFLOW_SOURCE, filter: { runId } }`. */
export const WORKFLOW_SOURCE = 'workflow';

export function workflowOperationHandlers(
  engine: WorkflowEngine,
  /**
   * With a store, `workflow.start` is journaled by its step key (the `effects` collection, like other external
   * effects): a replayed step returns the run it started instead of asking the engine again, so once-per-key
   * holds even for engines that ignore the idempotency key (Conductor OSS does). A crash between the engine's
   * answer and the journal write can still start a second run; the engine's own idempotency covers that window.
   */
  journal?: { store: Store; now: () => string },
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
      const effectId = `effect:${ctx.idempotencyKey}`;
      if (journal) {
        const done = await journal.store.transaction((tx) =>
          tx.get<{ result: unknown }>('effects', effectId),
        );
        if (done) return done.value.result;
      }
      const run = await engine.start(input.workflow, input.input, {
        tenantId: ctx.tenantId,
        taskId: ctx.taskId,
        idempotencyKey: ctx.idempotencyKey,
      });
      if (journal)
        await journal.store.transaction(async (tx) => {
          if (await tx.get('effects', effectId)) return;
          await tx.insert('effects', effectId, {
            taskId: ctx.taskId,
            operation: 'workflow.start',
            ...(ctx.stepKey ? { stepKey: ctx.stepKey } : {}),
            result: run,
            at: journal.now(),
          });
        });
      return run;
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

/**
 * Bridges engine completions into the trusted event ingress (deduplicated by run ID). A failed publish (a store
 * blip) is retried with doubling backoff; after `attempts` it is handed to `onError`, because the event ID makes a
 * later manual or polled redelivery safe (FEAT-038.2).
 */
export function bridgeWorkflowCompletions(
  engine: WorkflowEngine,
  publish: (event: {
    eventId: string;
    source: string;
    tenantId: string;
    payload: unknown;
  }) => Promise<boolean>,
  options: {
    attempts?: number;
    retryMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): void {
  const attempts = options.attempts ?? 5;
  const send = async (event: Parameters<typeof publish>[0]) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await publish(event);
        return;
      } catch (err) {
        if (attempt >= attempts) {
          try {
            options.onError?.(err);
          } catch {
            // The hook must not turn a reported failure into an unhandled one.
          }
          return;
        }
        await new Promise((r) =>
          setTimeout(r, (options.retryMs ?? 100) * 2 ** (attempt - 1)).unref(),
        );
      }
    }
  };
  engine.onFinished((run) => {
    void send({
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
