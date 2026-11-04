# Agentropy implementation roadmap

**Project state:** Documentation baseline revised after the [2026-11-04 design review](docs/review/2026-11-04-design-review.md). Implementation not started. M1 is a **walking skeleton** defined in [POC scope](docs/poc-scope.md); reassess M2+ after its retrospective.

**Execution planning:** [Staged todo-skills plan](docs/plans/PROJECT.md) and [lossless migration mapping](docs/plans/TODO-SKILLS-MIGRATION.md) are prepared. **Do not migrate this legacy TODO or start implementation** until architecture/requirements readiness gates, concrete test commands, and migration review are approved.

Task IDs are stable (former X-/C- items now sit inside the milestone where they are delivered). Requirement IDs refer to [requirements](docs/requirements.md); AC-xx to [POC scope](docs/poc-scope.md).

## Milestone 0 — Decisions and contract baseline (gate to M1)

- [x] M0-01 Approve implementation language/tooling — [ADR-0016](docs/adr/0016-implementation-language.md) accepted for M1; concrete packages at scaffold setup.
- [x] M0-02 Apache-2.0 LICENSE, DCO [CONTRIBUTING](CONTRIBUTING.md) guidance, and ESLint + Prettier code style selected ([ADR-0023](docs/adr/0023-license-and-contributions.md), [ADR-0016](docs/adr/0016-implementation-language.md)); automated checks remain M0-08.
- [x] M0-03 Core contracts reconciled; example journeys (J1, J2) and full transition tables documented. *Executable tests move to M1-10.*
- [x] M0-04 Capability contract, canonical capability catalog and profile resolution (design baseline).
- [x] M0-05 Trust-boundary M1 design signed off in [blueprint](docs/review/2026-11-04-m0-trust-boundaries.md) with [ADR-0024](docs/adr/0024-pre-dispatch-authorization-gate.md) activation gate; conformance stays M1/M2.
- [x] M0-06 Approve first persistence, wake-up scheduler and event transport — [ADR-0017](docs/adr/0017-first-persistence-and-activation.md) accepted (SQLite/polling/in-process M1).
- [x] M0-07 Minimum success scenario and measurable acceptance checks — [POC scope](docs/poc-scope.md).
- [x] X-01 Review ADR-0008…0018 individually: [status reconciliation](docs/review/2026-11-04-adr-status-reconciliation.md) recorded; proposed mechanisms remain proposed pending separate validation.
- [x] X-02 Canonical lifecycle transition tables, typed operation errors and guards specified ([runtime contract](docs/runtime-contract.md), [Errors v1](docs/contracts/errors-v1.md)). *Tests in M1-10.*
- [x] X-03 Versioned envelopes, actor trust boundary and idempotency fingerprint specified ([messaging contract](docs/messaging-contract.md)).
- [x] X-04 Exact pinning and upgrade policy specified ([runtime contract](docs/runtime-contract.md#version-pinning-and-upgrade)).
- [x] C-01 Communication v1 reconciled with Agent v1 (outbound SPI, call context, route binding).
- [ ] M0-08 Repository scaffold per ADR-0016: workspace, CI (lint, typecheck, test, offline), package skeletons, contribution docs.

## Accepted architecture decisions — 2026-11-04 (documentation follow-up only)

The discussion's accepted operational choices are recorded in [ADR-0019](docs/adr/0019-operational-and-communication-decisions.md). This **does not start M0 or M1**; outstanding implementation/tooling and persistence decisions remain open.

- [ ] D-01 Reconcile TaskAgent durability-required / scheduling-optional and MonitoringAgent scheduling-default in profiles, requirements and capability conformance.
- [x] D-02 Map the five logical communication families to v1 SPI, explicitly separate optional generic streaming/inquiry/discovery extensions and declare guarantees in [Communication v1](docs/contracts/communication-v1.md); implementation conformance remains M1/M2.
- [ ] D-03 Integrate central governance policy contracts and operational lifecycle (suspend, drain, retire, cancelTask), including interruption/checkpoint limitations.
- [ ] D-04 Document provider outage recovery, bounded retries, state retention and compatibility-gated migration/failover.
- [ ] D-05 Document configurable concurrency/queue/timeouts/retries/quotas, measurable metrics and post-POC SLO selection.
- [x] D-06 Document configuration precedence, non-weakening security floors, acceptance-time snapshot and live revocation checks in [Capability v1](docs/contracts/capability-v1.md); implementation tests remain open.
- [ ] D-07 Reconcile immutable version pinning, explicit audited migration, rollback and retirement constraints with ADR-0013.
- [ ] D-08 Document agent owner/share vs task ownership, user-level task isolation, strict tenant boundaries and explicit cross-tenant A2A grants.
- [ ] D-09 Retain Temporal–LangGraph TypeScript integration as an explicitly deferred decision; treat Codex collaboration and model-verification as optional non-core extensions.
- [ ] D-10 Add contract/conformance acceptance checks for the above before implementation, and review statuses of related older ADRs.
- [ ] D-11 Specify best-effort vs durable delivery requirements, provider guarantee negotiation, outbox/idempotency and no exactly-once claims (ADR-0019).
- [ ] D-12 Specify POC observability baseline: delegation success/latency, task outcomes, delivery failures, retry/deduplication, recovery duration, correlation and sensitive-data redaction (ADR-0019).
- [ ] D-13 Reconcile accepted OpenTelemetry baseline in ADR-0020 with contracts and POC criteria; reconcile accepted per-execution/delegation spans and async span links; finalize specific instrumentation names, sampling/redaction and conformance tests later.
- [ ] D-14 Align CommunicationProvider carrier injection/extraction and ObservabilityProvider span/export responsibilities with ADR-0020; specify W3C HTTP/A2A binding applicability, cross-trust sanitization, provider capabilities and propagation conformance tests.
- [ ] D-15 Reconcile accepted ADR-0021 delegated authorization model: distinct agent identities, scoped grant narrowing, audit chain, runtime reauthorization/revocation, default-denied impersonation, internal/A2A trust enforcement and long-running task tests; keep token exchange/IdP mechanism deferred.
- [ ] D-16 Specify long-running task authorization lifecycle: persisted authorization-blocked/waiting state, grant renewal and resumption, policy-driven timeout/cancellation, fresh sensitive-operation checks, and crash/retry conformance tests (ADR-0021).
- [ ] D-17 Specify pluggable CredentialProvider contract, opaque tenant-scoped references, just-in-time authorized resolution, rotation/renewal/revocation, cache/secret redaction and failure conformance (ADR-0021); defer backend choice.
- [ ] D-18 Define pluggable PDP contract and mandatory framework PEP checkpoints with default-deny, fail-closed evaluation, consistent internal/A2A/custom enforcement, audit decisions and conformance tests (ADR-0021); defer concrete policy engine selection.
- [ ] D-19 Specify PDP outage fail-closed behavior, durable policy-waiting recovery, bounded retries, cache scope and expiry, revocation freshness guarantees, audit signals and conformance tests (ADR-0021).
- [ ] D-20 Define runtime revocation checkpoints, cooperative cancellation and outcome-state reporting for in-flight operations, authorized compensation for committed effects, audit and cross-provider conformance tests (ADR-0021).
- [ ] D-21 Define independent AuditService/storage SPI, canonical mandatory security events, durable atomic/outbox recording and fail-closed policy, tamper-evidence verification, retention/tenant access and conformance tests (ADR-0021); defer concrete storage.
- [ ] D-22 Reconcile accepted ADR-0022: audit permissions, tenant-isolated query/export, legal hold, retention floors, tamper-evidence anchors, verified disposal and audit-of-audit; define conformance tests and leave durations/backends deferred.
- [x] D-23 Document the [security/governance closeout](docs/review/2026-11-04-security-governance-closeout.md) and add non-normative contract clarification for policy waiting, audit atomicity and candidate security checks; **implementation resolution and scope approval remain open**.
- [ ] D-24 Resolve or explicitly defer proposed defaults (break-glass, operational quarantine, dual control, audit schema, privacy/data residency) without treating them as accepted security policy.
- [ ] D-25 Finish concrete gate schema/error taxonomy and SEC-01…SEC-07 test scope for accepted [ADR-0024](docs/adr/0024-pre-dispatch-authorization-gate.md); design approved, executable conformance pending.
- [ ] D-26 Close G0-01…G0-07 design gates in [PROJECT plan](docs/plans/PROJECT.md), reconcile approved security/profile requirements, and review the [todo-skills migration](docs/plans/TODO-SKILLS-MIGRATION.md) before any replacement of this TODO.
- [ ] D-27 After readiness signoff, migrate backlog through todo-skills /todo-init and /todo-plan with exact runnable Done-when checks, <=120 active lines, verified ID crosswalk and unchanged unimplemented task statuses; keep future waves in plans.

## Security/Governance review closure

Architecture direction reviewed in [security/governance closeout](docs/review/2026-11-04-security-governance-closeout.md); accepted audit access/retention policy in [ADR-0022](docs/adr/0022-security-audit-governance.md). This closes the **design discussion**, not the contract-alignment tasks or implementation readiness gate.

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

- Milestones complete: **0 / 4**. M0: **12 / 13** documented items complete; **1** remains (M0-08 scaffold, tooling scripts and CI, including DCO check).
- Roadmap checkboxes: **15 / 78** complete (**12 M0 decisions/reviews + D-02, D-06, D-23 documentation alignment**). These are documentation/review completions only; **0 implementation milestones complete**.
