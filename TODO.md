# Agentropy implementation roadmap

**Project state:** Documentation baseline revised after the [2026-11-04 design review](docs/review/2026-11-04-design-review.md). Implementation not started. M1 is a **walking skeleton** defined in [POC scope](docs/poc-scope.md); reassess M2+ after its retrospective.

Task IDs are stable (former X-/C- items now sit inside the milestone where they are delivered). Requirement IDs refer to [requirements](docs/requirements.md); AC-xx to [POC scope](docs/poc-scope.md).

## Milestone 0 — Decisions and contract baseline (gate to M1)

- [ ] M0-01 Approve implementation language/tooling — [ADR-0016](docs/adr/0016-implementation-language.md) proposed. **Blocking.**
- [ ] M0-02 Select license, contribution policy (e.g. DCO) and code style. **Blocking.**
- [x] M0-03 Core contracts reconciled; example journeys (J1, J2) and full transition tables documented. *Executable tests move to M1-10.*
- [x] M0-04 Capability contract, canonical capability catalog and profile resolution (design baseline).
- [ ] M0-05 Trust-boundary note for M1 (principal derivation, tenant scoping, delegated grant narrowing) covering AC-09; full threat model → M2-09.
- [ ] M0-06 Approve first persistence, wake-up scheduler and event transport — [ADR-0017](docs/adr/0017-first-persistence-and-activation.md) proposed.
- [x] M0-07 Minimum success scenario and measurable acceptance checks — [POC scope](docs/poc-scope.md).
- [ ] X-01 Accept or revise ADR-0008…0014 and ADR-0016…0018 as a set.
- [x] X-02 Canonical lifecycle transition tables, typed operation errors and guards specified ([runtime contract](docs/runtime-contract.md), [Errors v1](docs/contracts/errors-v1.md)). *Tests in M1-10.*
- [x] X-03 Versioned envelopes, actor trust boundary and idempotency fingerprint specified ([messaging contract](docs/messaging-contract.md)).
- [x] X-04 Exact pinning and upgrade policy specified ([runtime contract](docs/runtime-contract.md#version-pinning-and-upgrade)).
- [x] C-01 Communication v1 reconciled with Agent v1 (outbound SPI, call context, route binding).
- [ ] M0-08 Repository scaffold per ADR-0016: workspace, CI (lint, typecheck, test, offline), package skeletons, contribution docs.

## Milestone 1 — Walking skeleton (single process, SQLite, offline CI)

Exit: all AC-01…AC-20 green ([POC scope](docs/poc-scope.md#exit-criteria)).

- [ ] M1-01 `core`: contract types, JSON Schemas, error catalog, transition tables as data (R-01, R-21, R-22).
- [ ] M1-02 Capability catalog, resolver and `EffectiveCapabilitySnapshot` (R-02, R-03).
- [ ] M1-03 Definition registry, instance directory and capability discovery (R-06).
- [ ] M1-04 TaskService/AgentService: delegate with idempotency + unknown acceptance, parent/child, depth/fan-out bounds (R-05, R-20). *Includes X-05 (async accepted handle, bounded `executeAndWait`, unknown-acceptance recovery).*
- [ ] M1-05 Runtime + bounded in-process pool, leases with epochs, one execution per run, retry policy, cancel grace period, history compaction (R-07, R-37).
- [ ] M1-06 SQLite store: tasks, executions, checkpoints, wake-ups, effect journal, outbox, inbox, human actions in one transaction boundary (R-08, R-34).
- [ ] M1-07 Outbox relay, `TaskEvent` publication with `(revision, sequence)`, inbox projection, `submitTurn` + turn-start briefing (R-12, R-29, R-36).
- [ ] M1-08 Wake-ups: polling scheduler (timer/schedule), in-process event bus with durable subscriptions and mailboxes, child-task and human-action wake-ups.
- [ ] M1-09 Human actions: request, claim/release, decide, expire (R-24). *Includes X-06 (HumanActionRequest with assignee, expiry, revision, atomic authorized decision), basic.*
- [ ] M1-10 Testkit: fake clock, fake model, failure injection; lifecycle edge generator; AC-01…AC-20.
- [ ] M1-11 Direct communication provider + router conformance suite (R-31). *Was C-02.*
- [ ] M1-12 Examples: `price-watch` (J1), `expense-approval` (J2) (R-17).
- [ ] M1-13 Retrospective: contract revisions forced by implementation, recorded in `docs/review/`.

## Milestone 2 — Always-on, interoperability and control

- [ ] M2-01 Monitoring at scale: many concurrent standing tasks, mailbox back-pressure, compaction tuning (builds on R-37 delivered in M1).
- [ ] M2-02 Scheduled and event-driven activation adapters with deduplication beyond in-process (R-11).
- [ ] M2-03 Inbox reconciliation/rebuild and independent markers (R-25). *Was X-07 (inbox projection/reconciliation; separate read/presented/resolved/acknowledged markers).*
- [ ] M2-04 Session briefing policy with urgent vs deferred delivery; shared priority resolver with policy floors (R-26). *Includes X-08 (shared priority resolver: business, user context, non-downgradable policy floor).*
- [ ] M2-05 Owner visibility and control: list/cancel tasks, suspend/resume instances, access controls (R-13).
- [ ] M2-06 Recovery tests across provider outage and delayed callbacks; transport-neutral outbox lease and replay (R-29). *Includes X-09 (transport-neutral idempotency, reliable outbox lease, duplicate/out-of-order and crash replay).*
- [ ] M2-07 Deterministic workflow-backed agent through a `workflow` provider (R-11, R-17).
- [ ] M2-08 AI task/monitoring agent with real `reasoning` provider, bounded tools and budget (R-35).
- [ ] M2-09 Full threat model: identity flows, token lifetimes, cross-boundary trust (ADR-0009).
- [ ] C-03 A2A provider: outbound and inbound, remote task mapping, authorization (R-32, R-33).
- [ ] C-04 Custom-provider SPI sample (broker/RPC) without a mandatory broker dependency.
- [ ] M2-10 Observability: OpenTelemetry traces/metrics, correlation through delegation, redaction (R-15, R-38).
- [ ] M2-11 Tenant isolation and quotas (R-16).

## Milestone 3 — Extensibility and production hardening

- [ ] M3-01 Second execution/workflow adapter with feature coverage and limitations (R-14).
- [ ] M3-02 Multi-worker pool: concurrency isolation, quotas, backpressure and fairness (R-10).
- [ ] M3-03 Provider version compatibility, checkpoint codecs, schema migrations and upgrade strategy (R-23, R-30).
- [ ] M3-04 Audit: tamper-evident sequence and retention (R-09, R-38).
- [ ] M3-05 Harden secrets, delegated authority and approval enforcement.
- [ ] M3-06 Benchmark throughput/latency/recovery and set SLOs from measurements.
- [ ] M3-07 PostgreSQL store adapter passing the same conformance suite (ADR-0017).
- [ ] M3-08 Kubernetes/OpenShift and air-gapped self-hosting examples.
- [ ] M3-09 Registry federation and discovery standards (R-18).
- [ ] M3-10 API reference, quickstarts and compatibility matrix.
- [ ] X-10 Reusable offline provider conformance kit published; per-app isolation and deployment failure matrix (R-28, R-30).
- [ ] C-05 Cross-provider conformance: idempotency, streaming, recovery, ownership, security.

## Definition of done per task

Implementation and docs agree (contract revision-history row added when a contract changes); tests cover the behavior including failure paths; errors use the [catalog](docs/contracts/errors-v1.md); unsupported guarantees fail explicitly; security and data-boundary impact reviewed; CHANGELOG updated. Keep examples small; no workflow-engine features.

## Progress

- Milestones complete: **0 / 4** (M0 has 7 of 13 items done; 4 open items need maintainer decisions).
- Tasks: **7 / 51** complete (all documentation/specification).
