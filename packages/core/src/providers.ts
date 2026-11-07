/**
 * Provider SPIs behind the `reasoning` and `workflow` capabilities (Capability v1, ADR-0006, M2-07/M2-08).
 * Engines and model APIs plug in here; agents only ever see the capability operations.
 */

export interface ReasoningMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ReasoningToolSpec {
  /** Provider-safe function name derived from the pinned tool ID. */
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ReasoningRequest {
  messages: ReasoningMessage[];
  maxTokens: number;
  temperature?: number;
  tools?: ReasoningToolSpec[];
}

export interface ReasoningResult {
  text: string;
  toolCalls?: { name: string; input: unknown }[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface ReasoningProvider {
  readonly id: string;
  complete(
    request: ReasoningRequest,
    ctx: { tenantId: string; taskId: string; signal: AbortSignal },
  ): Promise<ReasoningResult>;
}

export type WorkflowState = 'running' | 'completed' | 'failed';

export interface WorkflowRun {
  runId: string;
  state: WorkflowState;
  output?: unknown;
  /** Errors v1 code when failed. */
  code?: string;
}

/**
 * A deterministic workflow engine (Temporal, Quarkus Flow, …). `start` must be idempotent per `idempotencyKey`
 * (same key → same run). On completion the engine (or its adapter) calls `onFinished` so the runtime can wake
 * the waiting task through its `workflow` event subscription.
 */
export interface WorkflowEngine {
  readonly id: string;
  start(
    workflow: string,
    input: unknown,
    ctx: { tenantId: string; taskId: string; idempotencyKey: string },
  ): Promise<WorkflowRun>;
  status(runId: string, ctx: { tenantId: string }): Promise<WorkflowRun>;
  onFinished(listener: (run: WorkflowRun & { tenantId: string }) => void): void;
  /**
   * Optional, for engines that cannot push: re-checks the runs the engine started and reports the finished ones
   * through `onFinished`. `createLocalApp` calls it as a scheduler sweep, at most every `workflowPollMs`.
   */
  poll?(): Promise<unknown>;
}
