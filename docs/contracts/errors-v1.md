# Agentropy Error Contract v1 — revision 2

**Status:** Accepted for M1 implementation (2026-11-05; revision 1 was Proposed on 2026-11-04, ADR-0025 codes accepted on 2026-11-04). The catalog is implemented as data in `packages/core/src/errors.ts` and tested for completeness against this table.

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-04 | Initial catalog; ADR-0025 codes added |
| 2 | 2026-11-05 | Accepted for M1; contract error mapping for capability, tool, skill, implementation and route resolution; no new codes |

 Consolidates the error names previously spread across the [runtime contract](../runtime-contract.md), [Capability v1](capability-v1.md) and [Communication v1](communication-v1.md). Those documents now reference this catalog.

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
| `PolicyDecisionUnavailable` | authorization | no | No trustworthy current PDP decision (timeout, outage, error or indeterminate); protected action is blocked, but independently scheduled re-evaluation can occur |
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
| `AuditCommitUnavailable` | internal | no | Mandatory security audit intent could not be durably committed; protected state change must not report committed success |

\* `StaleRevision` is retryable only after re-reading current state.

## Contract error mapping (revision 2)

No new codes are needed for the revision-7 Agent contract; cases map onto the catalog with a `details.reason` or `details.kind`:

| Situation | Code | `details` |
|---|---|---|
| Unknown capability ID in a selection | `CapabilityUnavailable` | `{ reason: "unknown", id }` |
| Required capability removed; dependency cycle/conflict; contradictory duplicate | `InvalidConfiguration` | `{ reason, id }` |
| Ambiguous provider or tool binding | `CapabilityUnavailable` | `{ reason: "ambiguous", id }` |
| Missing `stepKey` on an `external` operation | `SchemaViolation` | `{ reason: "missingStepKey" }` |
| Tool/skill selection has no active version in range | `CapabilityUnavailable` | `{ kind: "tool" \| "skill", id }` |
| Skill dependency not satisfied | `CapabilityUnavailable` | `{ kind: "skill", reason: "dependency", id }` |
| Unknown implementation provider or artifact | `NotFound` | `{ kind: "implementation-provider" \| "implementation-artifact" }` |
| Unverified tool/skill/artifact activation or use | `PermissionDenied` | `{ reason: "unverified" }` |
| Suspended/revoked tool or revoked skill | `PermissionDenied` | `{ status }` |
| Pinned content changed or artifact removed | `IncompatibleVersion` | `{ kind }` |
| Durable profile on an implementation without checkpoint resume | `GuaranteeUnavailable` | `{ feature: "checkpointResume" }` |
| Remote-authority implementation in M1; skill script execution | `UnsupportedOperation` | `{ feature }` |
| Re-registration of same `id@version` with different content | `InvalidConfiguration` | `{ reason: "immutable" }` |
| Skill resource path escaping the skill root | `PermissionDenied` | `{ reason: "path" }` |

## Migration from earlier names

`NoCompatibleRoute`, `Unauthorized` → `PermissionDenied`, `RemoteUnavailable`, `UnknownAcceptance` (Communication v1); `CapabilityUnavailable` … `ProviderUnavailable` (Capability v1) are kept as-is; `Unauthorized` is the only rename.


## Security infrastructure failures — accepted 2026-11-04

[ADR-0025](../adr/0025-security-infrastructure-errors.md) adopts `PolicyDecisionUnavailable` and `AuditCommitUnavailable` as v1 catalog codes. Their public `retryable: false` **does not prohibit** a separate bounded internal scheduling retry for an accepted durable task. Explicit policy denial remains `PermissionDenied`; expired/revoked authority remains `AuthorityExpired`. A remote side-effect outcome still unknown remains `UnknownAcceptance`, not a false success/failure.

- `PolicyDecisionUnavailable`: no protected effect is dispatched. The activation gate may preserve an existing task/queue entry without changing its status.
- `AuditCommitUnavailable`: no new protected state change is reported committed when mandatory local audit intent cannot be persisted. Already-dispatched remote side effects require reconciliation rather than an invented rollback.
- Public responses redact secrets and inaccessible object existence; HTTP mappings and versioned client compatibility must be tested before releasing endpoints.
- Existing v1 categories remain unchanged; no promise of exactly-once effects.

