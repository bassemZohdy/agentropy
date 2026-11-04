# ADR-0020: OpenTelemetry as the cross-agent observability standard

- Status: Accepted (observability standard); span-boundary details below remain proposed
- Date: 2026-11-04
- Scope: Architecture and documentation only. No implementation or milestone execution authorized.

## Context

Agentropy is a provider-neutral, multi-runtime, multi-agent framework. Agent collaboration may cross in-process adapters, A2A, broker transports and execution providers. A single correlation model must support debugging and governance without binding the Agent contract to a telemetry SDK.

## Accepted decision

- Adopt **OpenTelemetry (OTel)** as the standard for traces, metrics and compatible log correlation across Agentropy agents, runtimes and communication adapters.
- The Agent and Capability contracts remain OTel-SDK-independent. Runtime/adapters instrument execution and export via pluggable OTel-compatible providers.
- Respect W3C Trace Context where compatible; use context propagation through authenticated transport boundaries with trust validation. Do not treat propagated telemetry context as identity or authorization.
- Use asynchronous context links where parent-child relationships are misleading or a task resumes long after the initiating request.
- Preserve durable task, message and execution identifiers independently from ephemeral trace IDs; traces are not a source of truth for recovery.
- Avoid recording prompt content, secrets, raw user data or sensitive authorization tokens in telemetry by default.
- Observability must work offline/air-gapped and support configurable sampling, export destinations, retention and redaction. No hosted telemetry vendor is mandatory.
- POC captures minimal correlated events/counters and recovery evidence; full dashboard/instrumentation hardening remains planned for later milestones.

## Proposed span and context boundaries — discussion required

1. An inbound conversation or agent invocation starts/continues an invocation span, with trace context propagated through trusted ingress.
2. Delegation emits a **producer/client span** for the send/acceptance operation, correlated to task ID, target agent and selected route. A separate task execution span begins on actual activation.
3. Direct internal communication can use parent-child spans in a continuous execution path; remote A2A or broker delivery propagates standard context with appropriate producer/consumer spans.
4. Durable asynchronous task activation, retry and recovery produce **new execution spans**, associated via span links and stable task/causation metadata rather than one infinitely long span.
5. Streaming uses a bounded stream-operation span with progress events/metrics, not a new span per chunk.
6. Human approval waiting is recorded as state events/duration metrics; a later human decision resumes through a new activation span linked to the waiting task.
7. Instrument provider boundaries (reasoning/tool/workflow/transport/persistence) without forcing third-party implementations to adopt the same SDK.
8. Cardinality controls: never use task IDs, user IDs, tenant IDs or free text as metric labels; use such identifiers only in appropriately controlled traces/logs where necessary.

## Open design questions

- Exact span taxonomy/naming and semantic convention version.
- Which asynchronous edges use parent-child relationships versus span links.
- Sampling defaults, retention and tenant-aware telemetry access policies.
- Minimum testkit assertions for trace continuity, redaction and failed delivery.

## Related

[ADR-0015 — Agent communication](0015-pluggable-agent-communication.md), [ADR-0019 — Operational decisions](0019-operational-and-communication-decisions.md), [POC scope](../poc-scope.md).

This ADR intentionally separates the **accepted choice of OTel** from the **proposed span design** pending explicit agreement.
