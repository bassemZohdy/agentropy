# Security & Governance design closeout — 2026-11-04

- Status: Review findings and proposed follow-up; **not** acceptance of unspecified implementation choices
- Project: Agentropy
- Scope: documentation and contract consistency only; no code, milestones, or infrastructure provisioning

## Accepted design baseline

- ADR-0019: tenant and user-level task isolation; agent vs task ownership; framework policy floors; governed lifecycle; durable messaging.
- ADR-0020: OpenTelemetry/W3C tracing context is not authentication or authorization; sensitive data is redacted.
- ADR-0021: agent/workload identity, scoped delegation, default-deny PDP/PEP, current authorization on protected operations, secure credential references, long-running tasks surviving grant expiration, fail-closed policy outages, live revocation, durable tamper-evident audit.
- ADR-0022: distinct audit privileges, tenant-isolated reads and exports, configurable retention floors, legal hold, controlled disposal, independent integrity verification, and audit-of-audit.

## Architecture review findings requiring contract reconciliation

### Critical before M1 acceptance

1. **Single lifecycle authority.** The runtime contract remains the canonical source of states and transitions. `authorization-blocked` / `policy-waiting` in ADR-0021 are semantic dispositions, **not new persisted state names**. Map them to the existing waiting/wakeup mechanism and typed reason until a separately versioned lifecycle change is approved. Apply revision/CAS guards and safe retry behavior.
2. **Audit atomicity and offline POC scope.** Reconcile mandatory audit-intent persistence and the outbox with SQLite M1 transactions. A deployed remote audit sink may lag; a committed local record is not remote ingestion. Include process-restart/replay and no-side-effect-on-audit-write-failure acceptance tests.
3. **Principal trust source.** Define authenticated, non-forgeable initiating principal, agent identity and tenant binding; distrust caller-authored actor/tenant metadata, message carriers and `traceparent`. Confirm delegation attenuation at every child hop.
4. **Policy decision and enforcement contracts.** Specify protected action/resource mapping, default-deny behavior, fail-closed errors, authn/authz ordering, immediate enforcement checkpoints and guard precedence preventing state leakage. An unavailable PDP must not become an allow.
5. **Revocation/failure outcomes.** Distinguish before-dispatch denial, cooperative in-flight cancellation, confirmed effect, and unknown effect. Never promise rollback; use idempotency and authorized compensation where applicable.
6. **Credentials.** Credential references must be tenant-bound, used just in time, and redacted. No bearer secrets in stored checkpoints, messages, event logs, telemetry or audit events.

### Important before M2/A2A interoperability

7. **Cross-tenant/cross-domain A2A.** Treat remote side as an independent trust domain; establish authentication, audience/target binding, replay controls, grant proof, status authority and cancellation limits. A2A support by itself supplies no authorization semantics or durable delivery guarantee.
8. **Multi-tenancy data access.** Cover registry, inbox, tasks, checkpoints, memory, task events, provider routing, audit and observability queries, not only API entry points. Test wrong-tenant and wrong-owner access via direct and remote paths.
9. **Human-in-the-loop and approvals.** Decisions must be scoped to an authenticated approver and task revision; keep grants separate from presenting a UI prompt. Record expired or duplicate decisions without accepting extra privilege.
10. **Privacy and retention.** Establish category-specific retention, encryption, export, redaction, legal-hold and disposal policies, without promising universal durations or unqualified erasure of mandatory audit.
11. **Operational resilience.** Test PDP loss, stale allow cache, revocation propagation, credential rotation, audit sink outage, cross-transport retries and crash recovery independently.

## Proposed defaults — need approval or implementation validation

- **Audit schema:** versioned canonical event IDs, actor/agent/task chain, resource/action/decision, outcome, safe reason, correlation, event-time and record-time; no secret values.
- **Access roles:** separate audit reviewer, audit security administrator, retention/hold manager and break-glass administrator, with least privilege; dual control is policy-configured.
- **Break-glass:** disabled by default; exceptional bounded scoped approval, justification, short lifetime, mandatory alert/audit and post-event review. Never an invisible policy bypass.
- **External trust:** default deny cross-tenant delegation; explicit policy and independently verified identity/trust required.
- **Observability:** audit remains unsampled; trace sampling never removes mandatory audit evidence.
- **Incident controls:** operational controls to quarantine/retire agents, revoke grants, stop new delegations, drain tasks and reconcile unknown side effects; mappings must use already approved lifecycle operations.
- **Compliance:** deployment owners specify data residency, retention periods and access restrictions; frameworks must not encode blanket jurisdiction-specific legal claims.

## Still deferred

Exact Keycloak/OBO/token-exchange flows and versions; Temporal/LangGraph TypeScript integration choice; concrete PDP/OPA engine, IAM federation, secret/audit backends, retention schedules, integrity anchors, and production SLOs. None has been validated or selected by these ADRs.

## Recommended closure / readiness gate

The design direction is complete enough to **stop introducing new foundational security ADRs** and instead reconcile the requirements, core contracts and POC checks. Do not mark M0/M1 complete: implementation language/licensing/persistence choices and runnable conformance remain open. The next authorized work should be documentation alignment and decisions on remaining M0 blockers, not feature implementation.
