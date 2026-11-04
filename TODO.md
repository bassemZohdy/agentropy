# Agentropy implementation roadmap

**Project state:** Documentation baseline; implementation not started. All tasks below are open. Reassess this plan when the first proof of concept validates the initial contracts.

## Milestone 0 — Foundation and architectural validation

- [ ] M0-01 Choose initial language/runtime and record ADR (assess TypeScript/Node.js and alternatives).
- [ ] M0-02 Select repo licensing, contribution policy and code style.
- [ ] M0-03 Validate domain entities and state transition tables with example journeys.
- [ ] M0-04 Define capability contract and profile resolution schema including required/default/optional semantics.
- [ ] M0-05 Define tenancy/identity, delegation and audit threat model.
- [ ] M0-06 Select first persistence, wake-up/scheduler, event transport and runtime adapter; create ADRs.
- [ ] M0-07 Define minimum user-visible success scenario and measurable POC acceptance checks.

## Milestone 1 — Minimal multi-agent core

- [ ] M1-01 Implement AgentDefinition/Profile/Instance/Task/Execution contracts and validation.
- [ ] M1-02 Implement capability descriptor, dependency/conflict resolver and effective config snapshot.
- [ ] M1-03 Implement local versioned definition registry, instance directory and capability discovery.
- [ ] M1-04 Implement task delegation with bounded agent selection, identity, correlation and parent-child tracking.
- [ ] M1-05 Implement in-process runtime and bounded execution pool; distinguish logical agents from leases.
- [ ] M1-06 Implement durable task/execution store, idempotency and compare-and-swap state transitions.
- [ ] M1-07 Implement structured progress/outcome event envelopes.
- [ ] M1-08 Add simple Conversational, Task and Monitoring profile examples.
- [ ] M1-09 Test immediate task delegation, multiple tasks per instance, failure, unauthorized delegation and concurrent execution.

## Milestone 2 — Always-on and durable collaboration

- [ ] M2-01 Persistent monitoring responsibility and durable wake-up registration.
- [ ] M2-02 Scheduled and event-driven activation adapters with deduplication.
- [ ] M2-03 Shared durable inbox, outbox publication, acknowledgement and replay.
- [ ] M2-04 Session start inbox retrieval and policy-based urgent vs deferred notifications.
- [ ] M2-05 Agent task inspection, pause/resume/cancel contracts and access controls.
- [ ] M2-06 Recovery tests: crash/restart, duplicate events, lease expiry, provider outage.
- [ ] M2-07 Deterministic workflow-backed agent (no model required).
- [ ] M2-08 AI-powered task/monitoring agent example using bounded tool permissions.

## Milestone 3 — Extensibility and production hardening

- [ ] M3-01 Add second execution/workflow adapter and document feature coverage and limitations.
- [ ] M3-02 Validate worker pool concurrency isolation, quotas, backpressure and fairness.
- [ ] M3-03 Provider version compatibility, checkpoints, schema migrations and upgrade strategy.
- [ ] M3-04 Observability: traces/metrics/logs/audit and user/task correlation.
- [ ] M3-05 Harden secrets, tenant isolation, delegated authority and approval enforcement.
- [ ] M3-06 Benchmark throughput/latency/recovery and define deployment SLOs.
- [ ] M3-07 Package optional Kubernetes/OpenShift and air-gapped self-hosting examples.
- [ ] M3-08 Evaluate agent-to-agent protocol/federation and registry discovery standards.
- [ ] M3-09 Document API reference, quickstarts and compatibility matrix.

## Definition of done per task

Implementation and docs agree; tests cover the affected behavior; errors and unsupported guarantees are explicit; security and data-boundary implications reviewed; CHANGELOG records meaningful changes. Keep examples small and avoid unrelated workflow-engine features.

## Progress

- Architecture baseline: published.
- Implemented milestones: **0 / 4**.
- Implementation tasks complete: **0 / 35**.
