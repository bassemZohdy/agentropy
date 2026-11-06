# ADR-0030: Hardening — approvals, secrets, and the D-24 governance items

- Status: Accepted (2026-11-06)
- Resolves: D-24 and M3-05. Related: [ADR-0021](0021-delegated-authorization.md), [ADR-0022](0022-security-audit-governance.md), [human actions](../human-actions.md), [threat model](../security/threat-model.md).

## Context

D-24 listed governance features that were deliberately not adopted for M1/M2: break-glass, operational quarantine, dual control, a canonical audit schema and data residency. M3-05 asks for hardened secret handling, delegated authority and approval enforcement. Each item needs a decision, so it is either built and tested or explicitly left to the deployment.

## Decision

1. **Separation of duties for approvals (built).** An `approval` human action cannot be decided by the principal who delegated the task (`NotAssignee`, `reason: selfApproval`). A request may opt out with `allowSelfApproval: true`; the opt-out is visible in the stored request.
2. **Dual control for approvals (built).** `requiredApprovals: N` (1–5, approvals only) resolves the request only when N distinct eligible principals submit the same decision input. Repeats by one principal count once; differing decisions are recorded (`human-action.approve-partial` audit events) and the request stays open until agreement or `dueAt`.
3. **Dual control for administrative actions (deployment).** Audit hold release, disposal, retention changes and instance upgrades are separate policy actions (Security v1 rev 7). A deployment that needs two-person control for them expresses it in its PDP or routes the change through an approval human action; the runtime adds no second mechanism.
4. **Break-glass (not adopted).** No code path bypasses the PEP. Emergency access is a policy decision of the PDP, which sees the principal and is audited like every other decision. A hidden override would defeat the audit and threat model.
5. **Operational quarantine (composed, not a new state).** Quarantining an agent instance is `suspendInstance` (no new tasks) plus `revokeAuthority` for its grants (running work stops at its next protected effect and waits behind the dispatch gate). See the [operations runbook](../operations.md#quarantine-an-agent-instance).
6. **Canonical audit schema (adopted).** `AuditEvent` in Security v1 is the canonical schema, versioned with that contract. Event types are namespaced (`task.*`, `instance.*`, `human-action.*`, `tool.*`, `audit.*`); changes are additive, and details are redacted before they are stored.
7. **Data residency (deployment).** The runtime keeps all state in the store it is given and calls only configured providers. Residency is achieved by deploying one store (and runtime) per residency zone and by restricting remote routes; the self-hosting guide (FEAT-028.8) documents this. No per-record residency tagging in the runtime.
8. **Secrets (verified).** Credentials are resolved per call and never stored; a canary test checks that a credential used by a tool appears nowhere in the store, outbox, audit sink, task errors or telemetry, including when the provider puts it in an error message.

## Consequences

Approvals are safe by default; existing flows where the requester approves must opt out explicitly. Administrative dual control and residency remain deployment choices, which keeps the runtime small. The canary test guards future changes against secret leaks.

## Alternatives

A runtime break-glass role (unaudited bypass risk); a `quarantined` instance state (duplicates suspend + revoke); a runtime-wide approval engine for administrative APIs (duplicates the PDP).
