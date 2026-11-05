# Design follow-ups (TASK-026)

- Status: Open. Created 2026-11-05 by the todo-skills migration (TASK-010). Text below is copied from the [legacy TODO archive](archive/TODO-legacy-2026-11-05.md) without loss; only link paths were rebased.
- Rule: each item is closed only by a contract/ADR change **and** an executable test or an explicit, recorded deferral with milestone. None of these items blocks the M1 walking skeleton unless an M1 root names it in `Depends:`.
- M1 coverage already accepted elsewhere: minimal PDP/PEP/audit/credential shapes in [Security v1](../contracts/security-v1.md) (partial D-17/D-18/D-21); suspend/resume/retire instance operations in M1 (partial D-03).

| Legacy ID | Item | Suggested milestone |
|---|---|---|
| `D-03` | Integrate central governance policy contracts and operational lifecycle (suspend, drain, retire, cancelTask), including interruption/checkpoint limitations. | M1 (instance ops) / M2 |
| `D-04` | Document provider outage recovery, bounded retries, state retention and compatibility-gated migration/failover. | M2 |
| `D-05` | Document configurable concurrency/queue/timeouts/retries/quotas, measurable metrics and post-POC SLO selection. | M2 |
| `D-07` | Reconcile immutable version pinning, explicit audited migration, rollback and retirement constraints with ADR-0013. | M3 |
| `D-08` | Document agent owner/share vs task ownership, user-level task isolation, strict tenant boundaries and explicit cross-tenant A2A grants. | M2 |
| `D-09` | Retain Temporal–LangGraph TypeScript integration as an explicitly deferred decision; treat Codex collaboration and model-verification as optional non-core extensions. | Deferred |
| `D-11` | Specify best-effort vs durable delivery requirements, provider guarantee negotiation, outbox/idempotency and no exactly-once claims (ADR-0019). | M1 basic / M2 |
| `D-12` | Specify POC observability baseline: delegation success/latency, task outcomes, delivery failures, retry/deduplication, recovery duration, correlation and sensitive-data redaction (ADR-0019). | M2 |
| `D-13` | Reconcile accepted OpenTelemetry baseline in ADR-0020 with contracts and POC criteria; reconcile accepted per-execution/delegation spans and async span links; finalize specific instrumentation names, sampling/redaction and conformance tests later. | M2 |
| `D-14` | Align CommunicationProvider carrier injection/extraction and ObservabilityProvider span/export responsibilities with ADR-0020; specify W3C HTTP/A2A binding applicability, cross-trust sanitization, provider capabilities and propagation conformance tests. | M2 |
| `D-15` | Reconcile accepted ADR-0021 delegated authorization model: distinct agent identities, scoped grant narrowing, audit chain, runtime reauthorization/revocation, default-denied impersonation, internal/A2A trust enforcement and long-running task tests; keep token exchange/IdP mechanism deferred. | M2 |
| `D-16` | Specify long-running task authorization lifecycle: persisted authorization-blocked/waiting state, grant renewal and resumption, policy-driven timeout/cancellation, fresh sensitive-operation checks, and crash/retry conformance tests (ADR-0021). | M2 |
| `D-17` | Specify pluggable CredentialProvider contract, opaque tenant-scoped references, just-in-time authorized resolution, rotation/renewal/revocation, cache/secret redaction and failure conformance (ADR-0021); defer backend choice. | M2 |
| `D-18` | Define pluggable PDP contract and mandatory framework PEP checkpoints with default-deny, fail-closed evaluation, consistent internal/A2A/custom enforcement, audit decisions and conformance tests (ADR-0021); defer concrete policy engine selection. | M1 minimal / M2 |
| `D-19` | Specify PDP outage fail-closed behavior, durable policy-waiting recovery, bounded retries, cache scope and expiry, revocation freshness guarantees, audit signals and conformance tests (ADR-0021). | M2 |
| `D-20` | Define runtime revocation checkpoints, cooperative cancellation and outcome-state reporting for in-flight operations, authorized compensation for committed effects, audit and cross-provider conformance tests (ADR-0021). | M2 |
| `D-21` | Define independent AuditService/storage SPI, canonical mandatory security events, durable atomic/outbox recording and fail-closed policy, tamper-evidence verification, retention/tenant access and conformance tests (ADR-0021); defer concrete storage. | M1 intent / M2 |
| `D-22` | Reconcile accepted ADR-0022: audit permissions, tenant-isolated query/export, legal hold, retention floors, tamper-evidence anchors, verified disposal and audit-of-audit; define conformance tests and leave durations/backends deferred. | M3 |
| `D-24` | Resolve or explicitly defer proposed defaults (break-glass, operational quarantine, dual control, audit schema, privacy/data residency) without treating them as accepted security policy. | M2 |
| `N-02` | (P1 execution isolation / runtime + testkit) Specify logical task/tenant isolation versus provider sandbox guarantees; add tests for simultaneous task execution, workspace/credential boundaries, lease expiry and retry contamination. **Done when:** isolation levels, explicit unsupported errors, and milestone-specific runnable conformance are approved; no false production sandbox claim. | M1 logical / M3 sandbox |
| `N-03` | (P2 exploratory / reasoning) Evaluate task-aware model routing under R-35 with cost, latency, quality, residency and policy constraints, keeping fallback vendor-neutral. **Done when:** offline benchmark matrix, security floors, fallback semantics and weighted tradeoffs are documented; no M1 implementation dependency. | M3+ |
| `T-04` | (P1 evaluation) Weighted comparison of MCP, UTCP and direct APIs per use case covering governance, latency, complexity, ecosystem and TypeScript/offline fit. **Done when:** evidence and tradeoffs are recorded; no mandatory protocol winner declared. | M2 |
