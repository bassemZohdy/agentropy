# Agentropy Observability Contract v1 — revision 6 (traces, metrics, propagation)

**Status:** Accepted for M2 implementation (2026-11-05). Resolves design follow-ups D-12, D-13 and D-14 ([design follow-ups](../plans/DESIGN-FOLLOWUPS.md)). Implemented by `Telemetry` in `@agentropy/core` and the OpenTelemetry adapter `openTelemetry()` in `@agentropy/runtime`; verified by `packages/testkit/test/telemetry.test.ts` against the OpenTelemetry SDK.

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-05 | Vendor-neutral `Telemetry` port, span model and links, baseline metrics, W3C carrier sanitization and redaction rules (TASK-026.4, FEAT-027.6) |
| 2 | 2026-11-06 | `agentropy.store.conflicts` counter for store serialization conflicts (FEAT-032.1) |
| 3 | 2026-11-06 | `agentropy.scheduler.errors` counter for scheduler ticks that threw (FEAT-037.1) |
| 4 | 2026-11-07 | `agentropy.outbox.failures` counter for failed outbox deliveries (FEAT-039.4) |
| 5 | 2026-11-08 | `agentropy.outbox.poisoned` counter for outbox rows given up on after `poisonAfter` failed deliveries |
| 6 | 2026-11-14 | `agentropy.scheduler.errors` also counts a wake-up poll sweep that threw (workflow poll, remote sync, human-action expiry); the poll goes on (FIX-052) |

## Port (normative)

```ts
interface Telemetry {
  startSpan(name: string, options?: { parent?: string; links?: string[]; kind?: 'internal' | 'server' | 'client' | 'producer' | 'consumer'; attributes?: Attributes }): TelemetrySpan;
  count(name: string, value: number, attributes?: Attributes): void;   // monotonic counter
  record(name: string, value: number, attributes?: Attributes): void;  // histogram; durations in ms
}
interface TelemetrySpan { readonly traceparent: string | undefined; setAttributes(a: Attributes): void; fail(code: string): void; end(): void }
```

The default is a no-op. Telemetry never changes behavior: a failing exporter must not fail a task, and no telemetry value is an authorization input.

## Spans and links (D-13)

| Span | Kind | Parent | Key attributes |
|---|---|---|---|
| `agentropy.task.accept` | server | sanitized ingress `traceparent`, or the delegating capability span | `agentropy.tenant.id`, `agentropy.instance.id`, `agentropy.correlation_id`, `agentropy.task.id` |
| `agentropy.task.execute` (one per activation) | consumer | the task's accept span (stored on the task as `traceparent`) | `agentropy.task.id`, `agentropy.execution.id`, `agentropy.agent.id`, `agentropy.activation`, `agentropy.attempt`, `agentropy.trigger`, `agentropy.wake.kind`, `agentropy.disposition` |
| `agentropy.capability.invoke` | client | the execute span | `agentropy.capability.id`, `agentropy.capability.operation` |

- A child task's accept span is a child of the parent's `delegation.delegate` capability span, so a delegation tree is one trace.
- An activation woken by an inbound event **links** to the producer's context when the event carried a valid `traceparent` (a link, not a parent: the task's trace stays its own).
- Failures set span status `ERROR` and `agentropy.error.code` to the Errors v1 code. Error messages are not recorded.
- Long-lived tasks produce one execute span per activation, so no span stays open while a task waits.

## Baseline metrics (D-12)

| Metric | Type | Attributes |
|---|---|---|
| `agentropy.tasks.accepted` | counter | `agentropy.agent.id`, `agentropy.profile` |
| `agentropy.tasks.finished` | counter (from published terminal events) | `agentropy.task.status`, `agentropy.outcome.code` |
| `agentropy.execution.duration` | histogram, ms | `agentropy.agent.id`, `agentropy.disposition` |
| `agentropy.capability.calls` | counter | `agentropy.capability.id`, `agentropy.capability.operation`, `agentropy.result` (`ok` or error code) |
| `agentropy.dispatch.gated` | counter | `agentropy.gate.reason` |
| `agentropy.mailbox.dropped` | counter | `agentropy.event.source` |
| `agentropy.outbox.delivery_lag` | histogram, ms | `agentropy.event.type` |
| `agentropy.trace.rejected` | counter | `carrier` (`delegate`, `event`) |
| `agentropy.store.conflicts` | counter | `agentropy.store.adapter` (`postgres`), `agentropy.store.outcome` (`retried`, `exhausted`), `agentropy.store.sqlstate` (`40001`, `40P01`) |
| `agentropy.scheduler.errors` | counter | `agentropy.error.code` |
| `agentropy.outbox.failures` | counter | `agentropy.event.type` |
| `agentropy.outbox.poisoned` | counter | `agentropy.event.type` |

Attribute values are identifiers, enums and codes with bounded cardinality per deployment; task and execution IDs appear on spans, never on metrics.

## Propagation and sanitization (D-14)

- The only carrier is a W3C `traceparent` string (version `00`, lowercase hex, non-zero trace and span IDs, exactly 55 characters). It enters through `delegate(…, { traceparent })`, `publishEvent({ …, traceparent })` and, internally, `CapabilityInvocationContext.traceparent`.
- Anything else is dropped and counted (`agentropy.trace.rejected`); the work starts a new root trace. `tracestate` and baggage are not propagated in v1.
- Trace context is a correlation hint from possibly untrusted callers: it never selects a tenant, principal, policy or route.
- Spans and metrics carry no inputs, outputs, payloads, prompts, checkpoints, error messages, credentials or grant references (verified by the suite).

## Out of scope for v1

Log correlation API, exemplars, sampling policy (left to the SDK), per-tenant telemetry isolation and remote-provider (A2A) carrier mapping (FEAT-027.8).
