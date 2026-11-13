/**
 * Operational limits (D-05, TASK-026.5): one validated view of every bound the runtime enforces, so operators can
 * see and set them in one place. Invalid values fail fast at startup with InvalidConfiguration.
 */
import { AgentropyError } from '@agentropy/core';

export interface RuntimeLimits {
  /** Concurrent executions per process. */
  poolSize: number;
  /** Execution lease; renewed by the heartbeat: on every tick and, in a started app, on a timer of its own (FIX-051). */
  leaseMs: number;
  /** Time a cancelled handler gets to stop before its lease is fenced. */
  cancelGraceMs: number;
  /**
   * Longest one activation may run (FEAT-037.2). Past it the handler's signal aborts with `Timeout`; a handler that
   * does not stop within `cancelGraceMs` is fenced like a lost lease (retry or fail by the task's retry policy).
   * Long work waits (`waiting`) instead of running long.
   */
  maxActivationMs: number;
  /** Finished execution records kept per task. */
  keepExecutions: number;
  /** Largest serialized checkpoint. */
  maxCheckpointBytes: number;
  /** Policy decision timeout. */
  pdpTimeoutMs: number;
  /** Delegation depth and children per parent. */
  maxDepth: number;
  maxFanOut: number;
  /** Unconsumed events per subscription. */
  mailboxLimit: number;
  /** Largest serialized task input, task output, inbound event payload and human-action prompt (FEAT-040.2). */
  maxInputBytes: number;
  maxOutputBytes: number;
  maxEventBytes: number;
  maxPromptBytes: number;
  /** ADR-0024 gate retry schedule. */
  gateRetry: { initialMs: number; maxMs: number; maxAttempts: number };
}

export const DEFAULT_LIMITS: RuntimeLimits = {
  poolSize: 4,
  leaseMs: 60_000,
  cancelGraceMs: 30_000,
  maxActivationMs: 600_000,
  keepExecutions: 20,
  maxCheckpointBytes: 64 * 1024,
  pdpTimeoutMs: 5_000,
  maxDepth: 5,
  maxFanOut: 20,
  mailboxLimit: 1_000,
  maxInputBytes: 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxPromptBytes: 16 * 1024,
  gateRetry: { initialMs: 1_000, maxMs: 300_000, maxAttempts: 8 },
};

/** Upper bounds that keep a misconfiguration from becoming a resource problem. */
const BOUNDS: Record<
  Exclude<keyof RuntimeLimits, 'gateRetry'>,
  [min: number, max: number]
> = {
  poolSize: [1, 1_024],
  leaseMs: [100, 3_600_000],
  cancelGraceMs: [0, 3_600_000],
  maxActivationMs: [100, 86_400_000],
  keepExecutions: [1, 10_000],
  maxCheckpointBytes: [256, 16 * 1024 * 1024],
  pdpTimeoutMs: [1, 300_000],
  maxDepth: [1, 64],
  maxFanOut: [1, 10_000],
  mailboxLimit: [1, 1_000_000],
  maxInputBytes: [1024, 64 * 1024 * 1024],
  maxOutputBytes: [1024, 64 * 1024 * 1024],
  maxEventBytes: [256, 16 * 1024 * 1024],
  maxPromptBytes: [64, 1024 * 1024],
};

/**
 * Refuses a value whose JSON serialization exceeds `max` bytes (`SchemaViolation`, reason `<what>TooLarge`), so a
 * payload cannot grow task rows, mailboxes and inbox entries without bound (FEAT-040.2).
 */
export function assertMaxBytes(
  value: unknown,
  max: number,
  what: 'input' | 'output' | 'event' | 'prompt',
): void {
  const size = Buffer.byteLength(JSON.stringify(value ?? null));
  if (size > max)
    throw new AgentropyError(
      'SchemaViolation',
      `The ${what} of ${size} bytes exceeds the ${max}-byte limit`,
      { details: { reason: `${what}TooLarge`, size, limit: max } },
    );
}

export function resolveLimits(
  overrides: Partial<RuntimeLimits> = {},
): RuntimeLimits {
  const limits: RuntimeLimits = {
    ...DEFAULT_LIMITS,
    ...overrides,
    gateRetry: { ...DEFAULT_LIMITS.gateRetry, ...overrides.gateRetry },
  };
  const bad = (field: string, value: unknown, range: string) =>
    new AgentropyError(
      'InvalidConfiguration',
      `Limit ${field} must be an integer in ${range}`,
      { details: { field, value: String(value), range } },
    );
  for (const [field, [min, max]] of Object.entries(BOUNDS)) {
    const v = limits[field as keyof typeof BOUNDS];
    if (!Number.isInteger(v) || v < min || v > max)
      throw bad(field, v, `[${min}, ${max}]`);
  }
  const g = limits.gateRetry;
  for (const k of ['initialMs', 'maxMs', 'maxAttempts'] as const)
    if (!Number.isInteger(g[k]) || g[k] < 1)
      throw bad(`gateRetry.${k}`, g[k], '[1, ∞)');
  if (g.maxMs < g.initialMs)
    throw bad('gateRetry.maxMs', g.maxMs, `[${g.initialMs}, ∞)`);
  // A lease shorter than the cancel grace would fence a stopping handler early.
  if (limits.cancelGraceMs > limits.leaseMs)
    throw bad(
      'cancelGraceMs',
      limits.cancelGraceMs,
      `[0, leaseMs=${limits.leaseMs}]`,
    );
  return Object.freeze({ ...limits, gateRetry: Object.freeze({ ...g }) });
}
