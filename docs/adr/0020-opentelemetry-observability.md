# ADR-0020: OpenTelemetry as the cross-agent observability standard

- Status: Accepted (observability standard and execution/delegation trace-boundary principles); detailed instrumentation taxonomy remains proposed
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

## Accepted trace-boundary principles (2026-11-04)

1. An inbound conversation or agent invocation starts/continues an invocation span, with trace context propagated through trusted ingress.
2. Delegation emits a **producer/client span** for the send/acceptance operation, correlated to task ID, target agent and selected route. A separate task execution span begins on actual activation.
3. Direct internal communication can use parent-child spans in a continuous execution path; remote A2A or broker delivery propagates standard context with appropriate producer/consumer spans.
4. Durable asynchronous task activation, retry and recovery produce **new execution spans**, associated via span links and stable task/causation metadata rather than one infinitely long span.
5. Preserve task ID, execution ID and correlation/causation identifiers independently of span/trace identifiers. A resumed task does not require the original trace to remain open.
6. Instrumentation is pluggable, so the same logical boundaries apply to internal and A2A communication without imposing a particular exporter.

## Accepted context propagation policy (2026-11-04)

- **Separation of responsibilities:** the `CommunicationProvider` injects/extracts transport context; the `ObservabilityProvider` creates, records and exports spans. Agent business logic and core contracts are independent of any OpenTelemetry SDK or transport.
- **Internal communication:** propagate active trace context using the OpenTelemetry Context API within the process, preserving the execution/dispatch boundary rules above.
- **A2A communication:** where supported by the transport and protocol, propagate W3C Trace Context (`traceparent`, `tracestate`) using HTTP headers. Do not assume every A2A binding carries HTTP headers; bindings need explicit compatible carrier mapping.
- **Custom transports:** adapters define compatible propagation carriers and injection/extraction while preserving the same protocol-neutral semantic contract.
- **Trust boundary:** extracted trace context is untrusted telemetry metadata, never proof of caller identity, tenant, delegation, or authorization. Validate authenticating principals and policy independently, limit/bound baggage and tracestate, and either sanitize/restart trace context or link to a trusted internal span where crossing external trust domains. Never blindly trust external sampling flags or baggage.
- **Durable continuity:** `taskId`, `executionId`, `correlationId` and `causationId` remain stable/domain-owned identifiers independent of `traceId`; retries, deferred work and restart recovery may create fresh traces/execution spans linked to prior activity.
- **Failure policy:** missing/malformed trace context does not fail an otherwise authorized business operation. Start a new trace if needed, record diagnostic context safely, and do not leak security-sensitive data in tracing carriers.
- **Provider negotiation:** each communication adapter declares context-propagation capabilities and limitations; observability interoperability must not silently change delivery, durability or authentication semantics.

## Proposed instrumentation conventions (not yet accepted)

- Streaming can use one bounded operation span with progress events/metrics rather than per-chunk spans.
- Human approval waiting can be represented via state events/duration metrics, with resumed activation linked to earlier execution.
- Instrument reasoning/tool/workflow/transport/persistence provider boundaries via adapters rather than mandatory SDK coupling.
- Apply cardinality guards: task, user and tenant identifiers must not be unbounded metric attributes.

## Open design questions

- Exact span taxonomy/naming and semantic convention version.
- Exact boundary mapping for individual asynchronous transports and how propagation interacts with span links.
- Sampling defaults, retention and tenant-aware telemetry access policies.
- Minimum testkit assertions for trace continuity, redaction and failed delivery.

## Related

[ADR-0015 — Agent communication](0015-pluggable-agent-communication.md), [ADR-0019 — Operational decisions](0019-operational-and-communication-decisions.md), [POC scope](../poc-scope.md).

The OTel choice and independent per-execution spans, delegation spans, parent-child for continuous synchronous paths, and span links for asynchronous retries/resumptions are accepted. Fine-grained instrumentation and sampling details remain proposed.
