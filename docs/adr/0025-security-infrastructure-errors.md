# ADR-0025: Explicit security infrastructure failure outcomes

- Status: **Proposed** (2026-11-04); requires acceptance before making new ErrorCode values normative
- Applies to: Agentropy AgentService/PEP, durable activation gate, AuditService and offline M1 SEC acceptance checks

## Problem

The current Error Contract v1 has `PermissionDenied`, `AuthorityExpired`, `ProviderUnavailable`, and `UnknownAcceptance`. A PDP outage is not a policy denial; failure to commit a mandatory audit intent is not an authorization denial. Using an ambiguous generic error would make retry/backoff and audit observability unsafe.

## Proposed additions

| Proposed code | Category | Public retryable flag | Meaning / effect |
|---|---|---|---|
| `PolicyDecisionUnavailable` | authorization (infrastructure) | no for the protected operation; runtime may schedule independent bounded re-evaluation | No reliable current PDP decision (error, timeout, unavailable, invalid response), hence **no protected effect dispatched** |
| `AuditCommitUnavailable` | internal (durability) | no for the just-submitted mutation; caller should reconcile request ID | Mandatory audit-intent durability could not be proved, hence **no new protected state change reported committed** |

The current `ErrorCategory` union does not include `security-infrastructure`; avoid a category breaking change in v1. Reconsider versioned categories later. The `retryable` flag means safe to blindly resubmit the **same public request**, not permission to reexecute an external side effect. Therefore keep both proposed codes `retryable: false`; scheduler retry is a separate internal policy.

## Enforcement boundaries and ordering

1. Authenticate verified principal and derive tenant; do not trust envelope or tracing claims.
2. Authorize the protected request using a current verifiable PDP decision. Explicit denial is `PermissionDenied`; revoked/expired grant is `AuthorityExpired`; unavailable/indeterminate evaluation is the proposed `PolicyDecisionUnavailable`.
3. Validate schema, idempotency and state/capabilities as documented, preserving non-disclosure of invisible entities.
4. Before committing protected state mutation, atomically persist mandatory audit intent. Failure returns the proposed `AuditCommitUnavailable` and makes no *new* state commit; if a remote effect is already dispatched, report/reconcile uncertainty rather than claiming rollback.
5. For durable accepted tasks with an unavailable PDP at activation, ADR-0024 stores an eligibility gate in `created`/`assigned` without creating an execution; retry via bounded scheduler policy after validation, independent from the error's public retryable flag.
6. No special error code bypasses authorization, task revision/CAS, provider idempotency or output redaction.

## Acceptance expectations

- SEC-01: policy outage/recovery does not create a protected execution/effect, and does not turn transient infrastructure outage into `PermissionDenied`.
- SEC-03: force audit-intent write failure before commit, assert no protected state mutation; crash after commit but before sink publish recovers through outbox and dedup.
- Security response does not disclose whether an invisible task/resource exists.
- A duplicate retry with the original idempotency key never generates duplicate side effects; unknown remote outcome remains `UnknownAcceptance`.

## Open before acceptance

Check compatibility with existing clients and decide whether `PolicyDecisionUnavailable` fits `authorization` or should use a future versioned category; define exact 4xx/5xx transport mapping, generic error redaction, and operational recovery/backoff parameters. Until approved, these two symbols are **candidate names**, not valid v1 catalog codes.

## Related

[Error Contract](../contracts/errors-v1.md) · [Runtime Contract](../runtime-contract.md) · [ADR-0024](0024-pre-dispatch-authorization-gate.md).
