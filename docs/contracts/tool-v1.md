# Agentropy Tool Contract v1 — revision 3

**Status:** Accepted for M1 implementation (2026-11-05) of the protocol-neutral core and a direct adapter. MCP, UTCP and REST/OpenAPI adapters are later work; no adapter is claimed beyond the executable tests in `packages/*/test`.
**Decision:** [ADR-0026](../adr/0026-protocol-agnostic-tool-integration.md). **Security:** [Security v1](security-v1.md), [ADR-0021](../adr/0021-delegated-authorization.md). **Errors:** [Errors v1](errors-v1.md).

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-05 | Canonical `ToolDescriptor`, tool lifecycle, `ToolRegistry`, `ToolExecutor`, `ToolProvider` SPI, resolution and invocation order |
| 2 | 2026-11-05 | Invocation step 8 enforced (FEAT-022.3, AC-07): an `external` tool that is not declared `at-least-once` fails `InvalidConfiguration` before audit or dispatch when its provider lacks `idempotencyKeys` |
| 3 | 2026-11-05 | D-04 (TASK-026.5): a binding may list `config.fallbackBindings`; only a `read` tool fails over to them, in order, after `ProviderUnavailable` or `Timeout`. Tools with effects never fail over (their failed outcome stays `UnknownAcceptance`) |

## Concepts

| Concept | Meaning | Not |
|---|---|---|
| `tool-use` capability | The handler's only effect surface for tools ([Capability v1](capability-v1.md)) | A list of tools |
| Tool | Logical, versioned callable operation with schemas and effect class | An endpoint or URL |
| Tool binding | Physical route to a provider (direct, MCP, UTCP, REST, custom) for one tool version | A permission |
| `ToolSelection` | Definition-level request to make a tool visible ([Agent v1](agent-v1.md)) | An authorization grant |

## TypeScript contract (normative)

```ts
export type ToolId = string;                 // lowercase dotted logical id, e.g. "finance.payout"

export type ToolStatus = "registered" | "active" | "suspended" | "revoked";

export interface ToolProvenance {
  publisher: string;
  source: string;                            // where the descriptor came from (package, MCP server, file)
  digest: string;                            // digest of the canonical descriptor
  verified: boolean;                         // set by the registry's verifier, never by a manifest
}

export interface ToolDescriptor {
  id: ToolId;
  version: Version;                          // SemVer, immutable once registered
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effect: "read" | "internal" | "external";  // external ⇒ step key required at invocation
  idempotency: "idempotent" | "keyed" | "at-least-once"; // "keyed": honors the derived idempotency key
  permission: string;                        // PDP action, e.g. "tool:finance.payout:call"
}

export interface ToolBinding {
  bindingId: string;
  toolId: ToolId;
  toolVersion: Version;
  providerId: string;
  providerVersion: Version;
  config: Record<string, unknown>;           // non-secret; secrets only as opaque credentialRef
  credentialRef?: string;
  default?: boolean;                         // default binding when a selection names none
}

export interface ToolRecord {
  descriptor: ToolDescriptor;
  provenance: ToolProvenance;
  bindings: ToolBinding[];
  status: ToolStatus;
  revision: number;
}

/** Pinned per task in the AcceptanceSnapshot. */
export interface ToolPin {
  toolId: ToolId;
  toolVersion: Version;
  bindingId: string;
  providerId: string;
  providerVersion: Version;
  digest: string;
}

export interface ToolProviderFeatures {
  protocol: string;                          // "direct" | "mcp" | "utcp" | "rest" | custom
  protocolVersion: string;
  cancellation: boolean;
  idempotencyKeys: boolean;                  // passes idempotency keys to the remote side
  streaming: boolean;
}

export interface ToolInvocationContext {
  tenantId: string;
  taskId: string;
  executionId: string;
  principal: TrustedPrincipal;
  idempotencyKey?: string;                   // derived by the runtime from stepKey
  credential?: unknown;                      // just-in-time resolved; never persisted or logged
  deadline?: string;
  signal: AbortSignal;
}

export interface ToolProvider {
  readonly id: string;
  readonly version: Version;
  readonly features: ToolProviderFeatures;
  invoke(binding: ToolBinding, descriptor: ToolDescriptor, input: unknown, ctx: ToolInvocationContext): Promise<unknown>;
}

export interface ToolRegistry {
  register(descriptor: ToolDescriptor, bindings: ToolBinding[], provenance: Omit<ToolProvenance, "digest" | "verified">, admin: TrustedPrincipal): Promise<ToolRecord>;
  activate(ref: VersionedRef, admin: TrustedPrincipal): Promise<ToolRecord>;
  suspend(ref: VersionedRef, admin: TrustedPrincipal): Promise<ToolRecord>;
  revoke(ref: VersionedRef, admin: TrustedPrincipal): Promise<ToolRecord>;
  get(ref: VersionedRef): ToolRecord | undefined;
  /** Discovery is metadata only and never implies invocation permission. */
  discover(query: { text?: string }, caller: TrustedPrincipal): Promise<ToolDescriptor[]>;
}

export interface ToolExecutor {
  invoke(pin: ToolPin, input: unknown, ctx: ToolInvocationContext & { stepKey?: string }): Promise<unknown>;
}
```

## Lifecycle

`registered → active ⇄ suspended`, any state → `revoked` (terminal). Register, activate, suspend and revoke are **protected administrative operations**: each requires an Allow decision for `tool-admin:<operation>` and a durable audit intent ([Security v1](security-v1.md)). Re-registering an identical `id@version` (same descriptor digest) is a no-op; different content → `InvalidConfiguration`. A descriptor from an untrusted source is stored with `verified: false` and cannot be activated (`PermissionDenied`).

## Resolution at task acceptance

For each `ToolSelection` (`id`, `versionRange`, `required`, optional `bindingId`):

1. `tool-use` must be in the effective capability set when any tool is selected → otherwise `InvalidConfiguration`.
2. Choose the highest `active` version that satisfies the range; none → `CapabilityUnavailable` (details `{ kind: "tool", id }`).
3. Choose the binding: explicit `bindingId`, else the single `default` binding, else the only binding; zero or ambiguous → `CapabilityUnavailable` (`reason: "binding"`). The binding's provider must be registered.
4. Ask the PDP for `descriptor.permission` for the accepting principal (visibility check); deny → `PermissionDenied`; PDP failure → `PolicyDecisionUnavailable`.
5. A failing **optional** selection is omitted and recorded in `AcceptanceSnapshot.omitted` with its error code; a failing **required** selection rejects acceptance. `PolicyDecisionUnavailable` always rejects (fail closed).

## Invocation order (ToolExecutor)

1. Pin present in the task's snapshot (handler cannot name an unpinned tool) → else `CapabilityNotDeclared`.
2. Record still `active` → `suspended`/`revoked` → `PermissionDenied` (details `status`).
3. Tenant: `principal.tenantId` equals `ctx.tenantId` → else `TenantMismatch`.
4. Fresh PDP decision for `descriptor.permission` (never a cached acceptance-time Allow) → `PermissionDenied` / `PolicyDecisionUnavailable`.
5. `effect: "external"` requires a `stepKey` → else `SchemaViolation` (`reason: "missingStepKey"`).
6. Validate input against `inputSchema` → `SchemaViolation`.
7. Durable audit intent → `AuditCommitUnavailable` (no dispatch).
8. Provider invocation with the derived idempotency key; provider errors map to `ProviderUnavailable`, `Timeout`, `UnknownAcceptance` or `Internal`. A provider without `idempotencyKeys` for an `external` tool is treated as at-least-once and must be declared `idempotency: "at-least-once"`.
9. Validate output against `outputSchema` → `SchemaViolation`.

Tool manifests, outputs and errors are untrusted data: they are validated and never change policy, bindings or authority. Fallback to a different binding mid-task is not performed in v1.

## Conformance checks

Discovery-only tool cannot be invoked; unverified tool cannot be activated; unauthorized activation denied; suspended/revoked tool denied at invocation; PDP outage fails closed; spoofed tenant rejected; missing step key on an external tool; schema violation in/out; same logical tool through two bindings gives the same result without agent code change; audit intent failure prevents dispatch; secrets never present in pins, config snapshots or errors.
