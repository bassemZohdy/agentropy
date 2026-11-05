/**
 * Observability port (docs/contracts/observability-v1.md, D-12/D-13/D-14, M2-10).
 *
 * A vendor-neutral surface the runtime calls for spans and metrics; the OpenTelemetry adapter in
 * `@agentropy/runtime` maps it onto `@opentelemetry/api`. Context crosses boundaries only as a W3C `traceparent`
 * string, which is validated before use and is never an authorization input. Attributes carry identifiers and
 * outcomes only — never inputs, outputs, payloads, prompts or credentials.
 */

export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

export interface TelemetrySpan {
  /** W3C traceparent of this span, for propagation to children; undefined when tracing is off. */
  readonly traceparent: string | undefined;
  setAttributes(attributes: Attributes): void;
  /** Marks the span failed with an Errors v1 code (no message, which may carry data). */
  fail(code: string): void;
  end(): void;
}

export interface SpanOptions {
  /** Parent context as a traceparent (already sanitized by the caller). */
  parent?: string;
  /** Causal links, e.g. the inbound event that woke a task. */
  links?: string[];
  kind?: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
  attributes?: Attributes;
}

export interface Telemetry {
  startSpan(name: string, options?: SpanOptions): TelemetrySpan;
  /** Monotonic counter. */
  count(name: string, value: number, attributes?: Attributes): void;
  /** Histogram sample (durations in milliseconds). */
  record(name: string, value: number, attributes?: Attributes): void;
}

const NOOP_SPAN: TelemetrySpan = {
  traceparent: undefined,
  setAttributes() {},
  fail() {},
  end() {},
};

export const NOOP_TELEMETRY: Telemetry = {
  startSpan: () => NOOP_SPAN,
  count() {},
  record() {},
};

/** Baseline metric names (D-12). Attribute keys are listed in the observability contract. */
export const METRICS = {
  tasksAccepted: 'agentropy.tasks.accepted',
  tasksFinished: 'agentropy.tasks.finished',
  executionDuration: 'agentropy.execution.duration',
  capabilityCalls: 'agentropy.capability.calls',
  dispatchGated: 'agentropy.dispatch.gated',
  mailboxDropped: 'agentropy.mailbox.dropped',
  outboxLag: 'agentropy.outbox.delivery_lag',
  traceRejected: 'agentropy.trace.rejected',
} as const;

/** Span names (D-13). */
export const SPANS = {
  accept: 'agentropy.task.accept',
  execute: 'agentropy.task.execute',
  capability: 'agentropy.capability.invoke',
} as const;

const TRACEPARENT =
  /^00-(?!0{32})([0-9a-f]{32})-(?!0{16})([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * D-14: accept only a well-formed version-00 W3C traceparent (lowercase hex, non-zero IDs). Anything else is
 * dropped, so malformed or oversized carriers cannot reach exporters or logs.
 */
export function sanitizeTraceparent(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length === 55 &&
    TRACEPARENT.test(value)
    ? value
    : undefined;
}

export function parseTraceparent(
  value: string,
): { traceId: string; spanId: string; sampled: boolean } | undefined {
  const m = TRACEPARENT.exec(value);
  if (!m) return undefined;
  return {
    traceId: m[1]!,
    spanId: m[2]!,
    sampled: (parseInt(m[3]!, 16) & 1) === 1,
  };
}

export const formatTraceparent = (
  traceId: string,
  spanId: string,
  sampled: boolean,
): string => `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
