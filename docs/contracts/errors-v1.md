# Agentropy Error Contract v1 — Design baseline

**Status:** Proposed (2026-11-04). Consolidates the error names previously spread across the [runtime contract](../runtime-contract.md), [Capability v1](capability-v1.md) and [Communication v1](communication-v1.md). Those documents now reference this catalog.

## Shape

```ts
export type ErrorCategory =
  | "validation" | "authorization" | "lifecycle" | "idempotency"
  | "capability" | "transport" | "limit" | "human-action" | "internal";

export interface AgentropyError {
  code: ErrorCode;            // stable, from the catalog below
  category: ErrorCategory;
  retryable: boolean;         // safe to retry the SAME request (same idempotency key)
  message: string;            // human-readable, no secrets or payload data
  correlationId?: string;
  details?: Record<string, unknown>; // e.g. { expectedRevision, actualRevision }
}
```

Rules:
- Errors are values on public boundaries (thrown as a typed `AgentropyError` subclass in-process, serialized as the shape above across transports). Never a silent no-op, never a generic string.
- `retryable` is about the request, not the business outcome. `PermissionDenied` is never retryable.
- Authorization is checked before state: a caller who cannot see a task gets `NotFound`/`PermissionDenied`, never a state-revealing error.
- Provider-specific errors are mapped to a catalog code at the adapter boundary; the original is kept only in redacted telemetry.

## Catalog

| Code | Category | Retryable | Meaning |
|---|---|---|---|
| `SchemaViolation` | validation | no | Input/output/config does not match its schema |
| `InvalidConfiguration` | validation | no | Capability or provider config invalid |
| `NotFound` | validation | no | Entity absent or not visible to the caller |
| `Unauthenticated` | authorization | no | No trusted principal |
| `PermissionDenied` | authorization | no | Principal lacks the permission/scope |
| `TenantMismatch` | authorization | no | Cross-tenant access attempted |
| `AuthorityExpired` | authorization | no | Delegated grant expired or revoked |
| `InvalidState` | lifecycle | no | Transition/operation not legal from current state |
| `StaleRevision` | lifecycle | yes* | Compare-and-swap failed; re-read then retry |
| `NotReady` | lifecycle | yes | Result requested for a non-terminal task |
| `TaskFailed` / `TaskCancelled` | lifecycle | no | Result requested for a terminal non-completed task; carries outcome |
| `InstanceUnavailable` | lifecycle | yes | Instance suspended |
| `IncompatibleVersion` | lifecycle | no | Pinned version cannot be executed or negotiated |
| `IdempotencyConflict` | idempotency | no | Same key, different request fingerprint |
| `CapabilityNotDeclared` | capability | no | Handler invoked a capability not in its snapshot |
| `CapabilityUnavailable` | capability | no | No provider can satisfy the selection |
| `UnsupportedOperation` | capability | no | Provider/router does not implement the operation |
| `GuaranteeUnavailable` | capability | no | Required guarantee (e.g. `durable-execution`) not offered |
| `ProviderUnavailable` | transport | yes | Provider temporarily unreachable |
| `Timeout` | transport | yes | Bounded wait elapsed; outcome known not to have happened |
| `UnknownAcceptance` | transport | yes | Outcome unknown; resolve by idempotency key |
| `NoCompatibleRoute` | transport | no | Router found no authorized, compatible provider |
| `RemoteUnavailable` | transport | yes | Remote agent endpoint unreachable |
| `QuotaExceeded` | limit | yes | Tenant/agent quota hit; retry after backoff |
| `BudgetExceeded` | limit | no | Task cost/time budget exhausted |
| `DelegationDepthExceeded` / `FanOutExceeded` | limit | no | Delegation bounds violated |
| `ActionExpired` / `ActionRevoked` | human-action | no | Human action no longer accepts decisions |
| `ActionConflict` | human-action | no | A different decision already resolved the request |
| `NotAssignee` | human-action | no | Caller not eligible for the request |
| `Internal` | internal | no | Bug; always logged with correlation |

\* `StaleRevision` is retryable only after re-reading current state.

## Migration from earlier names

`NoCompatibleRoute`, `Unauthorized` → `PermissionDenied`, `RemoteUnavailable`, `UnknownAcceptance` (Communication v1); `CapabilityUnavailable` … `ProviderUnavailable` (Capability v1) are kept as-is; `Unauthorized` is the only rename.
