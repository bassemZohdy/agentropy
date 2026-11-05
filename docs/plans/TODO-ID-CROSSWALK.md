# Legacy TODO — verified task ID crosswalk

- Generated from [TODO.md](../../TODO.md) on 2026-11-04.
- Original file blob SHA: `69a6607041a7ed6c48acfd653e4e3a14d8844e02`.
- Rows: **80**; unique IDs: **80**; completed: **17**; open: **63**.
- This is an **immutable planning snapshot**, not a live alternative backlog. The canonical statuses remain in TODO.md until migration. Reconcile changes made after this SHA before migration.
- `todo-skills` IDs are **not assigned yet**. Each row must eventually map to an active leaf, parent, deferred milestone plan or an archive with unchanged provenance/status. Never mark future work complete because its ADR is accepted.

| Legacy ID | Status on snapshot | Original group | Task description |
|---|---|---|---|
| `M0-01` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Approve implementation language/tooling — [ADR-0016](../../docs/adr/0016-implementation-language.md) accepted for M1; concrete packages at scaffold setup. |
| `M0-02` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Apache-2.0 LICENSE, DCO [CONTRIBUTING](../../CONTRIBUTING.md) guidance, and ESLint + Prettier code style selected ([ADR-0023](../../docs/adr/0023-license-and-contributions.md), [ADR-0016](../../docs/adr/0016-implementation-language.md)); automated checks remain M0-08. |
| `M0-03` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Core contracts reconciled; example journeys (J1, J2) and full transition tables documented. *Executable tests move to M1-10.* |
| `M0-04` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Capability contract, canonical capability catalog and profile resolution (design baseline). |
| `M0-05` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Trust-boundary M1 design signed off in [blueprint](../../docs/review/2026-11-04-m0-trust-boundaries.md) with [ADR-0024](../../docs/adr/0024-pre-dispatch-authorization-gate.md) activation gate; conformance stays M1/M2. |
| `M0-06` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Approve first persistence, wake-up scheduler and event transport — [ADR-0017](../../docs/adr/0017-first-persistence-and-activation.md) accepted (SQLite/polling/in-process M1). |
| `M0-07` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Minimum success scenario and measurable acceptance checks — [POC scope](../../docs/poc-scope.md). |
| `X-01` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Review ADR-0008…0018 individually: [status reconciliation](../../docs/review/2026-11-04-adr-status-reconciliation.md) recorded; proposed mechanisms remain proposed pending separate validation. |
| `X-02` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Canonical lifecycle transition tables, typed operation errors and guards specified ([runtime contract](../../docs/runtime-contract.md), [Errors v1](../../docs/contracts/errors-v1.md)). *Tests in M1-10.* |
| `X-03` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Versioned envelopes, actor trust boundary and idempotency fingerprint specified ([messaging contract](../../docs/messaging-contract.md)). |
| `X-04` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Exact pinning and upgrade policy specified ([runtime contract](../../docs/runtime-contract.md#version-pinning-and-upgrade)). |
| `C-01` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Communication v1 reconciled with Agent v1 (outbound SPI, call context, route binding). |
| `M0-08` | complete | Milestone 0 — Decisions and contract baseline (gate to M1) | Minimal TypeScript/pnpm workspace scaffold, four package shells, Vitest smoke test, ESLint/Prettier and GitHub CI verified ([evidence](../../docs/review/2026-11-04-m0-scaffold-verification.md)); runtime contract tests not implemented. |
| `D-01` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Reconcile TaskAgent durability-required / scheduling-optional and MonitoringAgent scheduling-default in profiles, requirements and capability conformance. |
| `D-02` | complete | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Map the five logical communication families to v1 SPI, explicitly separate optional generic streaming/inquiry/discovery extensions and declare guarantees in [Communication v1](../../docs/contracts/communication-v1.md); implementation conformance remains M1/M2. |
| `D-03` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Integrate central governance policy contracts and operational lifecycle (suspend, drain, retire, cancelTask), including interruption/checkpoint limitations. |
| `D-04` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Document provider outage recovery, bounded retries, state retention and compatibility-gated migration/failover. |
| `D-05` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Document configurable concurrency/queue/timeouts/retries/quotas, measurable metrics and post-POC SLO selection. |
| `D-06` | complete | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Document configuration precedence, non-weakening security floors, acceptance-time snapshot and live revocation checks in [Capability v1](../../docs/contracts/capability-v1.md); implementation tests remain open. |
| `D-07` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Reconcile immutable version pinning, explicit audited migration, rollback and retirement constraints with ADR-0013. |
| `D-08` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Document agent owner/share vs task ownership, user-level task isolation, strict tenant boundaries and explicit cross-tenant A2A grants. |
| `D-09` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Retain Temporal–LangGraph TypeScript integration as an explicitly deferred decision; treat Codex collaboration and model-verification as optional non-core extensions. |
| `D-10` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Add contract/conformance acceptance checks for the above before implementation, and review statuses of related older ADRs. |
| `D-11` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Specify best-effort vs durable delivery requirements, provider guarantee negotiation, outbox/idempotency and no exactly-once claims (ADR-0019). |
| `D-12` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Specify POC observability baseline: delegation success/latency, task outcomes, delivery failures, retry/deduplication, recovery duration, correlation and sensitive-data redaction (ADR-0019). |
| `D-13` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Reconcile accepted OpenTelemetry baseline in ADR-0020 with contracts and POC criteria; reconcile accepted per-execution/delegation spans and async span links; finalize specific instrumentation names, sampling/redaction and conformance tests later. |
| `D-14` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Align CommunicationProvider carrier injection/extraction and ObservabilityProvider span/export responsibilities with ADR-0020; specify W3C HTTP/A2A binding applicability, cross-trust sanitization, provider capabilities and propagation conformance tests. |
| `D-15` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Reconcile accepted ADR-0021 delegated authorization model: distinct agent identities, scoped grant narrowing, audit chain, runtime reauthorization/revocation, default-denied impersonation, internal/A2A trust enforcement and long-running task tests; keep token exchange/IdP mechanism deferred. |
| `D-16` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Specify long-running task authorization lifecycle: persisted authorization-blocked/waiting state, grant renewal and resumption, policy-driven timeout/cancellation, fresh sensitive-operation checks, and crash/retry conformance tests (ADR-0021). |
| `D-17` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Specify pluggable CredentialProvider contract, opaque tenant-scoped references, just-in-time authorized resolution, rotation/renewal/revocation, cache/secret redaction and failure conformance (ADR-0021); defer backend choice. |
| `D-18` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Define pluggable PDP contract and mandatory framework PEP checkpoints with default-deny, fail-closed evaluation, consistent internal/A2A/custom enforcement, audit decisions and conformance tests (ADR-0021); defer concrete policy engine selection. |
| `D-19` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Specify PDP outage fail-closed behavior, durable policy-waiting recovery, bounded retries, cache scope and expiry, revocation freshness guarantees, audit signals and conformance tests (ADR-0021). |
| `D-20` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Define runtime revocation checkpoints, cooperative cancellation and outcome-state reporting for in-flight operations, authorized compensation for committed effects, audit and cross-provider conformance tests (ADR-0021). |
| `D-21` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Define independent AuditService/storage SPI, canonical mandatory security events, durable atomic/outbox recording and fail-closed policy, tamper-evidence verification, retention/tenant access and conformance tests (ADR-0021); defer concrete storage. |
| `D-22` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Reconcile accepted ADR-0022: audit permissions, tenant-isolated query/export, legal hold, retention floors, tamper-evidence anchors, verified disposal and audit-of-audit; define conformance tests and leave durations/backends deferred. |
| `D-23` | complete | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Document the [security/governance closeout](../../docs/review/2026-11-04-security-governance-closeout.md) and add non-normative contract clarification for policy waiting, audit atomicity and candidate security checks; **implementation resolution and scope approval remain open**. |
| `D-24` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Resolve or explicitly defer proposed defaults (break-glass, operational quarantine, dual control, audit schema, privacy/data residency) without treating them as accepted security policy. |
| `D-25` | complete | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Document accepted [ADR-0024 gate shape](../../docs/adr/0024-pre-dispatch-authorization-gate.md), [ADR-0025 security error codes](../../docs/adr/0025-security-infrastructure-errors.md) and approved [M1 security test scope](../../docs/plans/M1-SECURITY-ACCEPTANCE-DECISION.md); executable SEC conformance remains M1-10. |
| `D-26` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Close G0-01…G0-07 design gates in [PROJECT plan](../../docs/plans/PROJECT.md), reconcile approved security/profile requirements, and review the [todo-skills migration](../../docs/plans/TODO-SKILLS-MIGRATION.md) before any replacement of this TODO. |
| `D-27` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | After readiness signoff, migrate backlog through todo-skills /todo-init and /todo-plan with exact runnable Done-when checks, <=120 active lines, verified ID crosswalk and unchanged unimplemented task statuses; keep future waves in plans. |
| `D-28` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Generate and commit `pnpm-lock.yaml` in a trusted pnpm 10.34.9 environment; switch CI to frozen-lockfile and re-enable dependency caching, verifying green CI. |
| `D-29` | open | Accepted architecture decisions — 2026-11-04 (documentation follow-up only) | Prove DCO workflow on sample signed/unsigned PRs; only then claim contributor-signoff enforcement verified. |
| `M1-01` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | `core`: contract types, JSON Schemas, error catalog, transition tables as data (R-01, R-21, R-22). |
| `M1-02` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Capability catalog, resolver and `EffectiveCapabilitySnapshot` (R-02, R-03). |
| `M1-03` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Definition registry, instance directory and capability discovery (R-06). |
| `M1-04` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | TaskService/AgentService: delegate with idempotency + unknown acceptance, parent/child, depth/fan-out bounds (R-05, R-20). *Includes X-05 (async accepted handle, bounded `executeAndWait`, unknown-acceptance recovery).* |
| `M1-05` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Runtime + bounded in-process pool, leases with epochs, one execution per run, retry policy, cancel grace period, history compaction (R-07, R-37). |
| `M1-06` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | SQLite store: tasks, executions, checkpoints, wake-ups, effect journal, outbox, inbox, human actions in one transaction boundary (R-08, R-34). |
| `M1-07` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Outbox relay, `TaskEvent` publication with `(revision, sequence)`, inbox projection, `submitTurn` + turn-start briefing (R-12, R-29, R-36). |
| `M1-08` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Wake-ups: polling scheduler (timer/schedule), in-process event bus with durable subscriptions and mailboxes, child-task and human-action wake-ups. |
| `M1-09` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Human actions: request, claim/release, decide, expire (R-24). *Includes X-06 (HumanActionRequest with assignee, expiry, revision, atomic authorized decision), basic.* |
| `M1-10` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Testkit: fake clock/model/policy/identity/audit, failure injection; AC-01…AC-20 plus SEC-01/02/03/04/07. |
| `M1-11` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Direct communication provider + router conformance suite (R-31). *Was C-02.* |
| `M1-12` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Examples: `price-watch` (J1), `expense-approval` (J2) (R-17). |
| `M1-13` | open | Milestone 1 — Walking skeleton (single process, SQLite, offline CI) | Retrospective: contract revisions forced by implementation, recorded in `docs/review/`. |
| `M2-01` | open | Milestone 2 — Always-on, interoperability and control | Monitoring at scale: many concurrent standing tasks, mailbox back-pressure, compaction tuning (builds on R-37 delivered in M1). |
| `M2-02` | open | Milestone 2 — Always-on, interoperability and control | Scheduled and event-driven activation adapters with deduplication beyond in-process (R-11). |
| `M2-03` | open | Milestone 2 — Always-on, interoperability and control | Inbox reconciliation/rebuild and independent markers (R-25). *Was X-07 (inbox projection/reconciliation; separate read/presented/resolved/acknowledged markers).* |
| `M2-04` | open | Milestone 2 — Always-on, interoperability and control | Session briefing policy with urgent vs deferred delivery; shared priority resolver with policy floors (R-26). *Includes X-08 (shared priority resolver: business, user context, non-downgradable policy floor).* |
| `M2-05` | open | Milestone 2 — Always-on, interoperability and control | Owner visibility and control: list/cancel tasks, suspend/resume instances, access controls (R-13). |
| `M2-06` | open | Milestone 2 — Always-on, interoperability and control | Recovery tests across provider outage and delayed callbacks; transport-neutral outbox lease and replay (R-29). *Includes X-09 (transport-neutral idempotency, reliable outbox lease, duplicate/out-of-order and crash replay).* |
| `M2-07` | open | Milestone 2 — Always-on, interoperability and control | Deterministic workflow-backed agent through a `workflow` provider (R-11, R-17). |
| `M2-08` | open | Milestone 2 — Always-on, interoperability and control | AI task/monitoring agent with real `reasoning` provider, bounded tools and budget (R-35). |
| `M2-09` | open | Milestone 2 — Always-on, interoperability and control | Full threat model: identity flows, token lifetimes, cross-boundary trust (ADR-0009). |
| `C-03` | open | Milestone 2 — Always-on, interoperability and control | A2A provider: outbound and inbound, remote task mapping, authorization (R-32, R-33). |
| `C-04` | open | Milestone 2 — Always-on, interoperability and control | Custom-provider SPI sample (broker/RPC) without a mandatory broker dependency. |
| `M2-10` | open | Milestone 2 — Always-on, interoperability and control | Observability: OpenTelemetry traces/metrics, correlation through delegation, redaction (R-15, R-38). |
| `M2-11` | open | Milestone 2 — Always-on, interoperability and control | Tenant isolation and quotas (R-16). |
| `M3-01` | open | Milestone 3 — Extensibility and production hardening | Second execution/workflow adapter with feature coverage and limitations (R-14). |
| `M3-02` | open | Milestone 3 — Extensibility and production hardening | Multi-worker pool: concurrency isolation, quotas, backpressure and fairness (R-10). |
| `M3-03` | open | Milestone 3 — Extensibility and production hardening | Provider version compatibility, checkpoint codecs, schema migrations and upgrade strategy (R-23, R-30). |
| `M3-04` | open | Milestone 3 — Extensibility and production hardening | Audit: tamper-evident sequence and retention (R-09, R-38). |
| `M3-05` | open | Milestone 3 — Extensibility and production hardening | Harden secrets, delegated authority and approval enforcement. |
| `M3-06` | open | Milestone 3 — Extensibility and production hardening | Benchmark throughput/latency/recovery and set SLOs from measurements. |
| `M3-07` | open | Milestone 3 — Extensibility and production hardening | PostgreSQL store adapter passing the same conformance suite (ADR-0017). |
| `M3-08` | open | Milestone 3 — Extensibility and production hardening | Kubernetes/OpenShift and air-gapped self-hosting examples. |
| `M3-09` | open | Milestone 3 — Extensibility and production hardening | Registry federation and discovery standards (R-18). |
| `M3-10` | open | Milestone 3 — Extensibility and production hardening | API reference, quickstarts and compatibility matrix. |
| `X-10` | open | Milestone 3 — Extensibility and production hardening | Reusable offline provider conformance kit published; per-app isolation and deployment failure matrix (R-28, R-30). |
| `C-05` | open | Milestone 3 — Extensibility and production hardening | Cross-provider conformance: idempotency, streaming, recovery, ownership, security. |

## Migration verification

1. Refresh or diff TODO.md against the recorded blob SHA; account for every added, removed or edited legacy task.
2. Keep historical IDs as `From:` provenance or in a sidecar crosswalk; assign todo-skills IDs only when the tree is created using its sequencing rules.
3. Validate the no-loss count by matching **each unique legacy ID exactly once** against a mapped destination; allow parent-to-leaf decompositions with explicit coverage.
4. Keep only near-term tasks in the active <=120-line todo-skills tree. Archive the original TODO before replacement and preserve later-milestone tasks in planning docs.
5. Confirm real test commands, branch setup and todo-skills lint before claiming successful migration.

No code or migrated backlog has been created by this snapshot.

## Migration destinations (2026-11-05)

The legacy TODO was migrated to the todo-skills format by **TASK-010** on 2026-11-05 and archived verbatim in [archive/TODO-legacy-2026-11-05.md](archive/TODO-legacy-2026-11-05.md). This table supersedes the snapshot above for destinations; it covers **all 96** legacy IDs (the 80 snapshot rows plus N-01…N-04, T-01…T-04, S-01…S-04 and A-01…A-04 added on 2026-11-05). Status is preserved exactly: every `complete` item maps to `archive`, and no `open` item is marked complete by migration. `scripts/check-readiness.mjs` verifies this table against the archive, `TODO.md` and `CHANGELOG.md` in CI.

A destination root is the todo-skills root that delivers (or, for TASK-026, resolves or explicitly defers) the legacy item. A legacy item is complete only when its destination root is drained to `CHANGELOG.md` with passing `Done when` commands.

| Legacy ID | Legacy status | Destination |
|---|---|---|
| `M0-01` | complete | archive |
| `M0-02` | complete | archive |
| `M0-03` | complete | archive |
| `M0-04` | complete | archive |
| `M0-05` | complete | archive |
| `M0-06` | complete | archive |
| `M0-07` | complete | archive |
| `X-01` | complete | archive |
| `X-02` | complete | archive |
| `X-03` | complete | archive |
| `X-04` | complete | archive |
| `C-01` | complete | archive |
| `M0-08` | complete | archive |
| `D-01` | open | FEAT-012 |
| `D-02` | complete | archive |
| `D-03` | open | TASK-026 |
| `D-04` | open | TASK-026 |
| `D-05` | open | TASK-026 |
| `D-06` | complete | archive |
| `D-07` | open | TASK-026 |
| `D-08` | open | TASK-026 |
| `D-09` | open | TASK-026 |
| `D-10` | open | TASK-010 |
| `D-11` | open | TASK-026 |
| `D-12` | open | TASK-026 |
| `D-13` | open | TASK-026 |
| `D-14` | open | TASK-026 |
| `D-15` | open | TASK-026 |
| `D-16` | open | TASK-026 |
| `D-17` | open | TASK-026 |
| `D-18` | open | TASK-026 |
| `D-19` | open | TASK-026 |
| `D-20` | open | TASK-026 |
| `D-21` | open | TASK-026 |
| `D-22` | open | TASK-026 |
| `D-23` | complete | archive |
| `D-24` | open | TASK-026 |
| `D-25` | complete | archive |
| `D-26` | open | TASK-010 |
| `D-27` | open | TASK-010 |
| `D-28` | complete | archive |
| `D-29` | open | TASK-025 |
| `M1-01` | open | FEAT-011 |
| `M1-02` | open | FEAT-012 |
| `M1-03` | open | FEAT-013 |
| `M1-04` | open | FEAT-017 |
| `M1-05` | open | FEAT-017 |
| `M1-06` | open | FEAT-016 |
| `M1-07` | open | FEAT-019 |
| `M1-08` | open | FEAT-018 |
| `M1-09` | open | FEAT-020 |
| `M1-10` | open | FEAT-022 |
| `M1-11` | open | FEAT-021 |
| `M1-12` | open | TASK-023 |
| `M1-13` | open | TASK-024 |
| `M2-01` | open | FEAT-027 |
| `M2-02` | open | FEAT-027 |
| `M2-03` | open | FEAT-027 |
| `M2-04` | open | FEAT-027 |
| `M2-05` | open | FEAT-027 |
| `M2-06` | open | FEAT-027 |
| `M2-07` | open | FEAT-027 |
| `M2-08` | open | FEAT-027 |
| `M2-09` | open | FEAT-027 |
| `C-03` | open | FEAT-027 |
| `C-04` | open | FEAT-027 |
| `M2-10` | open | FEAT-027 |
| `M2-11` | open | FEAT-027 |
| `M3-01` | open | FEAT-028 |
| `M3-02` | open | FEAT-028 |
| `M3-03` | open | FEAT-028 |
| `M3-04` | open | FEAT-028 |
| `M3-05` | open | FEAT-028 |
| `M3-06` | open | FEAT-028 |
| `M3-07` | open | FEAT-028 |
| `M3-08` | open | FEAT-028 |
| `M3-09` | open | FEAT-028 |
| `M3-10` | open | FEAT-028 |
| `X-10` | open | FEAT-028 |
| `C-05` | open | FEAT-028 |
| `N-01` | open | FEAT-014 |
| `N-02` | open | TASK-026 |
| `N-03` | open | TASK-026 |
| `N-04` | open | TASK-010 |
| `T-01` | open | FEAT-014 |
| `T-02` | open | FEAT-014 |
| `T-03` | open | FEAT-014 |
| `T-04` | open | TASK-026 |
| `S-01` | open | FEAT-011 |
| `S-02` | open | FEAT-015 |
| `S-03` | open | FEAT-015 |
| `S-04` | open | FEAT-015 |
| `A-01` | open | FEAT-011 |
| `A-02` | open | FEAT-017 |
| `A-03` | open | FEAT-012 |
| `A-04` | open | FEAT-022 |
