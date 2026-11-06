# ADR-0009: Governed agent delegation and auditable authority

- Status: Accepted (2026-11-06, TASK-034.1); detailed by ADR-0021, ADR-0024, ADR-0025 and ADR-0030
- Date: 2026-11-04

## Context

Agents can delegate work and invoke tools independently of the user's active session; identity, authority boundaries and policy are critical.

## Proposal

Apply least-privilege authorization to agent discovery, task assignment, tool execution, subscriptions, and inbox reads. Carry initiating principal, agent identity and task chain in an auditable context. Prefer bounded delegation over ungoverned impersonation. Enforce quotas, depth/fan-out limits, approvals and budget ceilings. Store sensitive credentials separately from task state.

## Consequences

Delegation is a policy decision, not merely a function call. Security becomes a core platform concern even if provided by pluggable identity adapters.

## Open

Identity provider flows, token lifetimes/refresh, scope enforcement and cross-boundary trust mechanisms need threat modeling and decisions.

## Evidence (2026-11-06, TASK-034.1)

- Least privilege on delegation, tools, subscriptions and inbox reads, with the initiating principal, agent and task chain audited: `packages/testkit/test/authorization.test.ts`, `packages/testkit/test/governance.test.ts`, `packages/testkit/test/security.test.ts`.
- Bounded delegation (narrowed grants), quotas, depth and fan-out limits, approvals and budgets: `packages/testkit/test/tenancy.test.ts`, `packages/testkit/test/operations.test.ts`, `packages/testkit/test/providers.test.ts`.
- Credentials are resolved per call and never stored with task state (TM-16, TM-33 in the [threat model](../security/threat-model.md)).
- The "Open" items are answered by the threat model (token lifetimes, cross-boundary trust for A2A peers). Identity provider integration stays with the transport, which hands the runtime an authenticated principal.
