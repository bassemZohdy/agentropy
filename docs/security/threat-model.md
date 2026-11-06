# Agentropy threat model — identity flows (M2-09, FEAT-027.7)

**Status:** revision 2 (2026-11-06; TM-29…TM-31 added by FEAT-028.4, TM-32…TM-33 by FEAT-028.5, TM-34 by FEAT-028.9). STRIDE analysis of every identity-bearing flow in the single-process runtime and its ingress adapters. Each mitigation names the test that proves it; `node scripts/check-readiness.mjs` fails if a referenced test file is missing. Rows marked *planned* name the backlog root that owns them. Related: [Security v1](../contracts/security-v1.md), [ADR-0021](../adr/0021-delegated-authorization.md), [ADR-0024](../adr/0024-pre-dispatch-authorization-gate.md).

## Trust boundaries and assets

- **Boundaries:** (B1) transport → runtime (HTTP, queue, webhook adapters hand over an authenticated principal); (B2) agent → agent inside the runtime; (B3) runtime → providers (tools, model APIs, workflow engines, credential store, policy point); (B4) runtime → store; (B5) runtime → telemetry/audit sinks; (B6) runtime ↔ remote A2A peers (planned).
- **Assets:** task inputs/outputs and checkpoints, delegated grants, credentials, inbox content, human decisions, audit trail, tenant separation.
- **Assumptions:** the transport authenticates callers and maps them to a `TrustedPrincipal`; the store and process are not attacker-controlled (store tampering is detected for audit rows only); policy and grant services are trusted but may be unavailable.

## Token and authority lifetimes

| Artifact | Lifetime | Freshness rule |
|---|---|---|
| Delegated grant (`delegatedAuthorityRef`) | Issuer-defined | Checked at acceptance, at every dispatch (gate) and before every protected effect; never cached |
| Narrowed child grant | No longer than its parent | Derived per child task by `GrantVerifier.narrow` |
| Policy decision | ≤ `ttlMs` (default 30 s) when `CachingPolicyDecisionPoint` is used | Invalidated by `revokeAuthority`, by a new policy version, or by expiry; failures never cached |
| Credential (API keys, tokens) | Provider-defined | Resolved per invocation, never stored or cached by the runtime |
| Human-action claim | 15 min default | Lapses back to `pending`; decisions re-check assignment, authority and revision |
| Trace context | Per request | Correlation only; validated and never an authorization input |

## STRIDE by flow

| ID | Flow | STRIDE | Threat | Mitigation | Evidence |
|---|---|---|---|---|---|
| TM-01 | F1 caller → AgentService | S | Envelope claims another actor or tenant | Transport principal replaces envelope actor/tenant; cross-tenant targets are `TenantMismatch` | `packages/testkit/test/security.test.ts` |
| TM-02 | F1 caller → AgentService | S | Unauthenticated call | `Unauthenticated` before any state is read | `packages/testkit/test/delivery.test.ts` |
| TM-03 | F1 caller → AgentService | T | Replayed or modified request reuses an idempotency key | Fingerprinted idempotency records: same key + different request is `IdempotencyConflict`; redeliveries return the original handle | `packages/runtime/test/task-service.test.ts` |
| TM-04 | F1 caller → AgentService | I | Probing other users' tasks or instances by ID | Not-owner and other-tenant reads are `NotFound`; listings are owner-scoped | `packages/testkit/test/owner-control.test.ts` |
| TM-05 | F1 caller → AgentService | D | One tenant floods acceptance | Per-tenant quotas (active tasks, accepts per minute, instances) checked in the accepting transaction | `packages/testkit/test/tenancy.test.ts` |
| TM-06 | F1 caller → AgentService | E | Delegating to another user's agent | Only owner, shares, same-owner agents and trusted services may delegate | `packages/testkit/test/governance.test.ts` |
| TM-07 | F2 agent → agent | E | Child task inherits the full parent grant | Grant narrowed to the target; refusal denies the delegation | `packages/testkit/test/authorization.test.ts` |
| TM-08 | F2 agent → agent | R | Untraceable chain of delegations | `task.accept` audit records caller type, parent task and narrowing | `packages/testkit/test/authorization.test.ts` |
| TM-09 | F2 agent → agent | D | Runaway recursion or fan-out | Depth and fan-out limits (`DelegationDepthExceeded`, `FanOutExceeded`) | `packages/testkit/test/operations.test.ts` |
| TM-10 | F3 events and callbacks | S | Forged event for another tenant | Event tenant comes from the transport principal; `event:publish` policy check | `packages/testkit/test/delivery.test.ts` |
| TM-11 | F3 events and callbacks | T | Duplicate or replayed callback triggers work twice | Inbound event IDs deduplicated, also across restarts | `packages/testkit/test/delivery.test.ts` |
| TM-12 | F3 events and callbacks | D | Event storm fills a subscription | Per-subscription mailbox limit with counted drops | `packages/testkit/test/scale.test.ts` |
| TM-13 | F4 human approvals | S | Non-assignee or other-tenant approves | Assignment check (`NotAssignee`), tenant check (`NotFound`), policy `human-input:decide` | `packages/runtime/test/human-actions.test.ts` |
| TM-14 | F4 human approvals | T | Stale screen approves a changed request | `expectedRevision` → `StaleRevision`; conflicting second decision → `ActionConflict` | `packages/runtime/test/human-actions.test.ts` |
| TM-15 | F4 human approvals | E | Approval with an expired or revoked grant | Grant re-checked per decision (`AuthorityExpired`) | `packages/runtime/test/human-actions.test.ts` |
| TM-16 | F5 tools and credentials | I | Secrets persisted in tasks, audit or errors | Credentials resolved per call, never stored; error and audit details redacted | `packages/testkit/test/authorization.test.ts` |
| TM-17 | F5 tools and credentials | E | Revoked grant keeps acting during a long run | Grant checked before every protected effect; `revokeAuthority` signals running work | `packages/testkit/test/authorization.test.ts` |
| TM-18 | F5 tools and credentials | T | Duplicate external effect after a crash | Derived idempotency keys; keyed tools refused on providers without key support | `packages/testkit/test/effects.test.ts` |
| TM-19 | F6 model calls | E | Model invokes tools the task was not granted | Only snapshot-pinned tools are offered; proposals execute through `tool-use.call` | `packages/testkit/test/providers.test.ts` |
| TM-20 | F6 model calls | D | Unbounded model spend | Task budget in tokens (`BudgetExceeded`), `maxTokens` capped | `packages/testkit/test/providers.test.ts` |
| TM-21 | F6 model calls | I | Provider error bodies echo prompts or keys | Typed errors only; provider bodies dropped | `packages/testkit/test/providers.test.ts` |
| TM-22 | F7 audit and telemetry | R | Audit rows altered or deleted | Per-tenant hash chain; `verify` reports the first broken row | `packages/testkit/test/authorization.test.ts` |
| TM-23 | F7 audit and telemetry | I | Audit read across tenants | `audit:read` permission, other tenants `NotFound` | `packages/testkit/test/authorization.test.ts` |
| TM-24 | F7 audit and telemetry | T | Malicious trace header pollutes telemetry | Strict `traceparent` validation; rejects counted; payloads never in spans | `packages/testkit/test/telemetry.test.ts` |
| TM-25 | F7 audit and telemetry | R | Protected change committed without audit | Audit intent in the same transaction; failure aborts (`AuditCommitUnavailable`) | `packages/testkit/test/security.test.ts` |
| TM-26 | B3 policy point | D | Policy outage lets work through | Fail closed; dispatch gate with bounded retries; failures never cached | `packages/testkit/test/security.test.ts` |
| TM-27 | F8 remote A2A peers | S | Remote peer impersonates a tenant or agent | Peer identity comes only from transport authentication (unauthenticated → 401); inbound A2A calls go through the same AgentService PEPs and the local policy | `packages/testkit/test/a2a.test.ts` |
| TM-28 | F8 remote A2A peers | E | Local authority leaks to, or is escalated by, a peer | Outbound calls carry only this runtime's credential; no grant reference or caller identity is sent; remote results and errors are data mapped to typed codes | `packages/testkit/test/a2a.test.ts` |
| TM-29 | F7 audit and telemetry | T | Whole chain rewritten consistently, or newest rows deleted, by someone with store access | Chain head published to an external anchor sink; `verify` with anchors reports `anchor-mismatch` or `truncated` | `packages/testkit/test/audit-retention.test.ts` |
| TM-30 | F7 audit and telemetry | R | Evidence destroyed before its time or during an investigation | Disposal only of expired, forwarded rows outside active legal holds; tenant retention cannot go below the deployment floor; disposal leaves a receipt that keeps the chain verifiable | `packages/testkit/test/audit-retention.test.ts` |
| TM-32 | F4 human approvals | E | Requester approves their own request, or one approver acts alone on a high-risk decision | Self-approval refused by default; `requiredApprovals` needs N distinct agreeing approvers | `packages/testkit/test/hardening.test.ts` |
| TM-33 | F5 tools and credentials | I | Credential leaks through provider error text into errors, events, audit or spans | Provider errors are mapped without their text; canary test scans store, outbox, audit sink, task errors and spans | `packages/testkit/test/hardening.test.ts` |
| TM-34 | F8 remote A2A peers | S/T | Discovery used for request forgery, or a card redirects delegations to an attacker host | Only configured https peers fetched; endpoint must be same-origin or explicitly allowed; strict size and field validation; tenant and policy scoping | `packages/testkit/test/federation.test.ts` |
| TM-31 | F7 audit and telemetry | E | Audit administration used without trace | Read, verify, export, retention, hold, release, anchor and dispose are separate permissions; uses and denials are themselves audited | `packages/testkit/test/audit-retention.test.ts` |

## Residual risks (accepted for M2)

- A compromised process or store can read task data; encryption at rest and KMS integration are deployment concerns (FEAT-028.5/.8). Audit anchoring protects only as well as the anchor sink is isolated from store writers.
- Break-glass is not adopted; administrative dual control and data residency are deployment policy ([ADR-0030](../adr/0030-hardening-and-d24-decisions.md)).
- Quotas are per tenant only; per-user quotas and cost attribution are M3.
