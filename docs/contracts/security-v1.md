# Agentropy Security Contract v1 — revision 1 (M1 minimal PEP/PDP/audit)

**Status:** Accepted for M1 implementation (2026-11-05). Implements the M1 subset of [ADR-0021](../adr/0021-delegated-authorization.md), [ADR-0024](../adr/0024-pre-dispatch-authorization-gate.md) and [ADR-0025](../adr/0025-security-infrastructure-errors.md). Policy engines, identity providers, credential backends and audit storage remain deferred (D-17…D-22). **Errors:** [Errors v1](errors-v1.md).

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-05 | Minimal `PolicyDecisionPoint`, PEP evaluation order, `AuditIntentWriter` and `CredentialProvider` shapes for M1 |

## TypeScript contract (normative)

```ts
export interface PolicyRequest {
  principal: TrustedPrincipal;                 // from the trusted ingress, never from message content
  action: string;                              // e.g. "delegation:delegate", "tool:finance.payout:call"
  resource: { type: string; id: string; tenantId: string };
  context?: Record<string, unknown>;           // redacted attributes only
}

export type PolicyDecision =
  | { effect: "allow"; policyVersion?: string }
  | { effect: "deny"; reason?: string; policyVersion?: string };

export interface PolicyDecisionPoint {
  /** Throwing, timing out or returning anything else is "unavailable" and fails closed. */
  decide(request: PolicyRequest, signal?: AbortSignal): Promise<PolicyDecision>;
}

export interface AuditEvent {
  type: string;                                // e.g. "tool.invoke", "tool.activate", "skill.register"
  tenantId: string;
  principalId: string;
  action: string;
  resource: { type: string; id: string };
  decision: "allow" | "deny" | "error";
  correlationId?: string;
  taskId?: string;
  details?: Record<string, unknown>;           // redacted; never secrets or payloads
  at: string;
}

export interface AuditIntentWriter {
  /** Must durably commit before the protected change is reported committed. Failure → AuditCommitUnavailable. */
  record(event: AuditEvent): Promise<void>;
}

export interface CredentialProvider {
  /** Just-in-time resolution of an opaque, tenant-scoped reference. Never cached in snapshots. */
  resolve(ref: string, ctx: { tenantId: string; principal: TrustedPrincipal; purpose: string }): Promise<unknown>;
}
```

## Policy enforcement point (PEP) order

Every protected operation evaluates, before any state change or effect:

1. Trusted principal present → else `Unauthenticated`.
2. `principal.tenantId === resource.tenantId` → else `TenantMismatch` (no PDP call).
3. PDP decision: `allow` → continue; `deny` → `PermissionDenied`; throw/timeout/unknown shape → `PolicyDecisionUnavailable` (fail closed, ADR-0025).
4. Durable audit intent for state-changing or external operations: write failure → `AuditCommitUnavailable`; the operation is not dispatched or reported committed.

Denials are audited on a best-effort basis; a failed denial audit never turns a denial into an allow. Allow decisions are never reused across protected operations (no stale Allow, SEC-02).

## Redaction

`AgentropyError.message`, audit `details`, snapshots and logs never contain credentials, bearer tokens or tool payloads. Credential values exist only inside the `ToolInvocationContext` of one invocation.

## Conformance checks (M1 subset)

Unauthenticated, tenant mismatch, deny, PDP throw, PDP timeout, malformed decision → each typed; audit failure prevents the protected operation; fresh decision per invocation; secrets absent from snapshots and serialized errors (SEC-02/03/04, AC-09).
