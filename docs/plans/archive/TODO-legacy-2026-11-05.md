# Legacy TODO.md — verbatim archive (replaced 2026-11-05)

- Archived by the todo-skills migration in TASK-010. Source blob: `084cfd080bdfb89b45f5d88eb71aa49706600d2e` on `main` at `ff49452`.
- The content below is unchanged and fenced so its historical relative links are not resolved from this folder. Every task ID is mapped in the [ID crosswalk](../TODO-ID-CROSSWALK.md#migration-destinations-2026-11-05).

~~~markdown
# Agentropy implementation roadmap

**Project state:** Documentation baseline revised after the [2026-11-04 design review](docs/review/2026-11-04-design-review.md). M0 workspace scaffold exists; M1 runtime implementation not started. M1 is a **walking skeleton** defined in [POC scope](docs/poc-scope.md); reassess M2+ after its retrospective.

**Architecture readiness:** [Final gate review](docs/review/2026-11-04-architecture-readiness.md) identifies remaining error/gate/verification choices. An accepted design principle does not imply test completion.

**Execution planning:** [Staged todo-skills plan](docs/plans/PROJECT.md), [first-wave implementation plan](docs/plans/FIRST-WAVE.md) and [lossless migration mapping](docs/plans/TODO-SKILLS-MIGRATION.md) are prepared. **Do not migrate this legacy TODO or start implementation** until architecture/requirements readiness gates, concrete test commands, and migration review are approved.

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
- [x] M0-08 Minimal TypeScript/pnpm workspace scaffold, four package shells, Vitest smoke test, ESLint/Prettier and GitHub CI verified ([evidence](docs/review/2026-11-04-m0-scaffold-verification.md)); runtime contract tests not implemented.

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
- [x] D-25 Document accepted [ADR-0024 gate shape](docs/adr/0024-pre-dispatch-authorization-gate.md), [ADR-0025 security error codes](docs/adr/0025-security-infrastructure-errors.md) and approved [M1 security test scope](docs/plans/M1-SECURITY-ACCEPTANCE-DECISION.md); executable SEC conformance remains M1-10.
- [ ] D-26 Close G0-01…G0-07 design gates in [PROJECT plan](docs/plans/PROJECT.md), reconcile approved security/profile requirements, and review the [todo-skills migration](docs/plans/TODO-SKILLS-MIGRATION.md) before any replacement of this TODO.
- [ ] D-27 After readiness signoff, migrate backlog through todo-skills /todo-init and /todo-plan with exact runnable Done-when checks, <=120 active lines, verified ID crosswalk and unchanged unimplemented task statuses; keep future waves in plans.
- [x] D-28 Lockfile [committed](https://github.com/bassemZohdy/agentropy/commit/7608c3c0353c0880ef62e87cba8f8ae2d2fce41f) by pnpm 10.34.9; frozen install and cache validated by [successful main CI](https://github.com/bassemZohdy/agentropy/actions/runs/41867123312).
- [ ] D-29 Signed/unsigned temporary-git DCO unit tests pass in [CI](https://github.com/bassemZohdy/agentropy/actions/runs/41866666152); verify DCO workflow on a real PR before claiming PR enforcement complete.

## Security/Governance review closure

Architecture direction reviewed in [security/governance closeout](docs/review/2026-11-04-security-governance-closeout.md); accepted audit access/retention policy in [ADR-0022](docs/adr/0022-security-audit-governance.md). This closes the **design discussion**, not the contract-alignment tasks or implementation readiness gate.

## Milestone 1 — Walking skeleton (single process, SQLite, offline CI)

Exit: all AC-01…AC-20 plus SEC-01/02/03/04/07 green in offline CI ([POC scope](docs/poc-scope.md#exit-criteria)).

- [ ] M1-01 `core`: contract types, JSON Schemas, error catalog, transition tables as data (R-01, R-21, R-22).
- [ ] M1-02 Capability catalog, resolver and `EffectiveCapabilitySnapshot` (R-02, R-03).
- [ ] M1-03 Definition registry, instance directory and capability discovery (R-06).
- [ ] M1-04 TaskService/AgentService: delegate with idempotency + unknown acceptance, parent/child, depth/fan-out bounds (R-05, R-20). *Includes X-05 (async accepted handle, bounded `executeAndWait`, unknown-acceptance recovery).*
- [ ] M1-05 Runtime + bounded in-process pool, leases with epochs, one execution per run, retry policy, cancel grace period, history compaction (R-07, R-37).
- [ ] M1-06 SQLite store: tasks, executions, checkpoints, wake-ups, effect journal, outbox, inbox, human actions in one transaction boundary (R-08, R-34).
- [ ] M1-07 Outbox relay, `TaskEvent` publication with `(revision, sequence)`, inbox projection, `submitTurn` + turn-start briefing (R-12, R-29, R-36).
- [ ] M1-08 Wake-ups: polling scheduler (timer/schedule), in-process event bus with durable subscriptions and mailboxes, child-task and human-action wake-ups.
- [ ] M1-09 Human actions: request, claim/release, decide, expire (R-24). *Includes X-06 (HumanActionRequest with assignee, expiry, revision, atomic authorized decision), basic.*
- [ ] M1-10 Testkit: fake clock/model/policy/identity/audit, failure injection; AC-01…AC-20 plus SEC-01/02/03/04/07.
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

- Milestones complete: **0 / 4** by final-readiness signoff. M0 checklist: **13 / 13** tasks completed (minimal scaffold verified); final design signoff, lockfile and DCO PR validation remain tracked separately.
- Roadmap checkboxes: **18 / 80** complete (**13 M0 decisions/scaffold tasks + D-02, D-06, D-23, D-25 documentation alignment**). M0-08 has a verified smoke-tested scaffold only; **no M1 agent runtime implementation** has started.

## 2026-11-05 — News-driven design follow-ups (not implementation completion)

The following clarifications reuse ADR-0021 and existing R-IDs; they do not change the accepted TypeScript/A2A/provider-neutral baseline or override G0 readiness gates.

- [ ] N-01 (P0 design / security lane) Align R-09/R-27 and ADR-0021 with explicit MCP/plugin discovery → verified registration → approved activation → invocation checkpoints; specify permissions for install/update/startup hooks and audit events. **Done when:** approved contract matrix covers internal/A2A/custom calls, revocation and PDP-failure denial; proposed SEC tests mapped to the existing M1 security gate.
- [ ] N-02 (P1 execution isolation / runtime + testkit) Specify logical task/tenant isolation versus provider sandbox guarantees; add tests for simultaneous task execution, workspace/credential boundaries, lease expiry and retry contamination. **Done when:** isolation levels, explicit unsupported errors, and milestone-specific runnable conformance are approved; no false production sandbox claim.
- [ ] N-03 (P2 exploratory / reasoning) Evaluate task-aware model routing under R-35 with cost, latency, quality, residency and policy constraints, keeping fallback vendor-neutral. **Done when:** offline benchmark matrix, security floors, fallback semantics and weighted tradeoffs are documented; no M1 implementation dependency.
- [ ] N-04 (readiness / docs) Trace N-01…N-03 into requirements, architecture, ADR, acceptance and todo-skills migration crosswalk before scheduling. **Done when:** G0-02/G0-07 review explicitly accepts scope and no existing tasks are silently marked complete.

## 2026-11-05 — Protocol-agnostic Tool Integration (ADR-0026)

- [ ] T-01 (P0 design) Specify canonical ToolDescriptor, ToolRegistry, ToolExecutor and ToolProvider SPI; separate logical tool identity/version, agent Capability and physical provider binding. **Done when:** two provider bindings expose one logical tool without changing Agent contracts.
- [ ] T-02 (P0 security) Reconcile registration, verified provenance, approved activation, per-invocation PEP/PDP, delegated authorization, credentials and audit for MCP, UTCP, REST and custom adapters with ADR-0021 and N-01. **Done when:** negative security test matrix is approved.
- [ ] T-03 (P1 conformance) Define schema/error mapping, provider feature negotiation, timeout/cancel/streaming, unknown outcomes, idempotency and safe fallback. **Done when:** offline tests exercise two adapters and failure scenarios; milestone approval pending.
- [ ] T-04 (P1 evaluation) Weighted comparison of MCP, UTCP and direct APIs per use case covering governance, latency, complexity, ecosystem and TypeScript/offline fit. **Done when:** evidence and tradeoffs are recorded; no mandatory protocol winner declared.

All T tasks are open design/implementation follow-ups and do not change current readiness gates or claim implementation completion.

## 2026-11-05 — Standard Agent Skills (extension of ADR-0026)

- [ ] S-01 (P0 contract design) Update versioned AgentDefinition schema with independently selected/pinned Skill references and document Capability/Tool/Skill boundaries. **Done when:** contracts and migration compatibility reviewed; no implicit authority expansion.
- [ ] S-02 (P1 integration) Specify Agent Skills-compatible SkillRegistry/SkillLoader with `SKILL.md`, optional scripts/references/assets, verified provenance and metadata-first lazy loading. **Done when:** official-format fixture passes import/discovery/loading conformance without conversion.
- [ ] S-03 (P0 security design) Map Skill registration, activation, update and script/tool invocation to ADR-0021's PEP/PDP, audit, credentials and tenant isolation. **Done when:** malicious-Skill and unauthorized execution negative test plan approved.
- [ ] S-04 (P1 compatibility) Define version pinning, invalid/missing dependency errors, sandbox/unsupported guarantees, restart and conformance tests. **Done when:** tests and milestone allocation reviewed in readiness gates.

These are open follow-ups. No Agent Skills loader or runtime implementation is claimed.

## 2026-11-05 — Agent Definition and pluggable implementations (contract revision 6)

- [ ] A-01 (P0 schema compatibility) Review and ratify the revised mandatory/optional `AgentDefinition` shape, including `implementation`, optional `skills`/`tools`, generic profile, JSON Schemas and backwards migration. **Done when:** cross-contract schema/type validation and migration examples are approved; revision 6 remains design-only until acceptance.
- [ ] A-02 (P0 implementation SPI) Specify `AgentImplementationProvider` registration, artifact trust, feature/guarantee negotiation and version pinning; distinguish native handler, LangGraph.js, workflow, and remote A2A proxy from task transport authority. **Done when:** two different implementations pass an equivalent task lifecycle test plan without bypassing TaskService.
- [ ] A-03 (P0 resolution/security) Reconcile profile/capability resolution with ToolSelection, SkillSelection, dependency checks, policy intersection and redacted acceptance snapshots. **Done when:** missing/invalid dependencies, privilege escalation, revoked grants and incompatible guarantees fail with mapped typed errors.
- [ ] A-04 (P1 conformance) Add provider-neutral tests for optionality, durable profile requirements, skill authorization separation, version pinning, recovery, cancellation, and remote task authority. **Done when:** runnable test commands and milestone scope are reviewed by readiness gates.

These are open implementation/design follow-ups; editing documentation does not close S-01, T-01, M1 gates or mean a provider has been implemented.
~~~
