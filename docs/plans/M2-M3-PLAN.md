# M2 and M3 plan (FEAT-027, FEAT-028)

- Status: Open; decomposed just-in-time after the M1 retrospective (TASK-024). Text copied from the [legacy TODO archive](archive/TODO-legacy-2026-11-05.md); only link paths were rebased. Reassess scope after M1 as the legacy roadmap required.

## M2

Milestone 2 — Always-on, interoperability and control. Root: **FEAT-027**.

- `M2-01` Monitoring at scale: many concurrent standing tasks, mailbox back-pressure, compaction tuning (builds on R-37 delivered in M1).
- `M2-02` Scheduled and event-driven activation adapters with deduplication beyond in-process (R-11).
- `M2-03` Inbox reconciliation/rebuild and independent markers (R-25). *Was X-07 (inbox projection/reconciliation; separate read/presented/resolved/acknowledged markers).*
- `M2-04` Session briefing policy with urgent vs deferred delivery; shared priority resolver with policy floors (R-26). *Includes X-08 (shared priority resolver: business, user context, non-downgradable policy floor).*
- `M2-05` Owner visibility and control: list/cancel tasks, suspend/resume instances, access controls (R-13).
- `M2-06` Recovery tests across provider outage and delayed callbacks; transport-neutral outbox lease and replay (R-29). *Includes X-09 (transport-neutral idempotency, reliable outbox lease, duplicate/out-of-order and crash replay).*
- `M2-07` Deterministic workflow-backed agent through a `workflow` provider (R-11, R-17).
- `M2-08` AI task/monitoring agent with real `reasoning` provider, bounded tools and budget (R-35).
- `M2-09` Full threat model: identity flows, token lifetimes, cross-boundary trust (ADR-0009).
- `M2-10` Observability: OpenTelemetry traces/metrics, correlation through delegation, redaction (R-15, R-38).
- `M2-11` Tenant isolation and quotas (R-16).
- `C-03` A2A provider: outbound and inbound, remote task mapping, authorization (R-32, R-33).
- `C-04` Custom-provider SPI sample (broker/RPC) without a mandatory broker dependency.

Backlog mapping (2026-11-05): FEAT-027.1 = M2-05; FEAT-027.2 = M2-03, M2-04; FEAT-027.3 = M2-02, M2-06; FEAT-027.4 = M2-01; FEAT-027.5 = M2-07, M2-08; FEAT-027.6 = M2-10; FEAT-027.7 = M2-09, M2-11; FEAT-027.8 = C-03, C-04; FEAT-027.9 = remote targets in delegation (C-03 completion). Contract work for the same areas is TASK-026.2–.5 ([design follow-ups](DESIGN-FOLLOWUPS.md#resolution-ledger-2026-11-05-task-0261)).

## M3

Milestone 3 — Extensibility and production hardening. Root: **FEAT-028**.

- `M3-01` Second execution/workflow adapter with feature coverage and limitations (R-14).
- `M3-02` Multi-worker pool: concurrency isolation, quotas, backpressure and fairness (R-10).
- `M3-03` Provider version compatibility, checkpoint codecs, schema migrations and upgrade strategy (R-23, R-30).
- `M3-04` Audit: tamper-evident sequence and retention (R-09, R-38).
- `M3-05` Harden secrets, delegated authority and approval enforcement.
- `M3-06` Benchmark throughput/latency/recovery and set SLOs from measurements.
- `M3-07` PostgreSQL store adapter passing the same conformance suite (ADR-0017).
- `M3-08` Kubernetes/OpenShift and air-gapped self-hosting examples.
- `M3-09` Registry federation and discovery standards (R-18).
- `M3-10` API reference, quickstarts and compatibility matrix.
- `X-10` Reusable offline provider conformance kit published; per-app isolation and deployment failure matrix (R-28, R-30).
- `C-05` Cross-provider conformance: idempotency, streaming, recovery, ownership, security.
